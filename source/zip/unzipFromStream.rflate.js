// Considerations:
//
// * `rflate` is `fflate` with its pure-javascript `DEFLATE` code replaced by a Rust one
//   compiled to WebAssembly. The API and the `.zip` handling code are `fflate`'s,
//   so the comments about `fflate` below (and the linked `fflate` issues) apply to it as well.
//   https://github.com/DeandreT/rflate
//
// * `fflate`'s pure-javascript decompressor is about 2x slower than Node.js's "native" `zlib` module,
//   which is why this code can "marry" the `Unzip` class with Node.js's `zlib` through some tinkering.
//   https://github.com/101arrowz/fflate/issues/284
//
// * Even though `fflate` implements a "streaming" mode of its own,
//   it does not implement Node.js streams "contract", i.e. it just unzips the archive
//   as fast as it can consume it from the input stream, without throttling the data throughput
//   in cases when the input data flows faster than `fflate` can process it. This means that
//   in the "worst case" scenario when `fflate`'s decompressor is unable to keep up with the
//   data influx, it would "buffer" the entire `.zip` archive in RAM until it's processed.
//   And while this is no big deal by any means, it's still not as elegant as adhering to
//   Node.js streaming protocol.

// This code was originally submitted by Stian Jensen.
// https://github.com/catamphetamine/read-excel-file/pull/122
// https://github.com/catamphetamine/read-excel-file/pull/123

// A `*.zip` file consists of individual file entries with the "total" summary section
// placed at the end of the file rather than at the start of it, which was originally done
// to allow for easy append of data to a given `.zip` file.
// https://en.wikipedia.org/wiki/ZIP_(file_format)
//
// But this also means that reading a `*.zip` file from a stream can't really be done
// using the "officially recommended" way of first reading the "total" summary section
// and only then reading the individual file entries specified in that summary section.
//
// So in order to be able to read a `*.zip` file from a stream, some corners have to be cut.
// For example, the "total" summary section is completely ignored and instead the reader
// should adopt "data recovery" software approach — it should proactively "scan" the input stream
// for individual file entries and handle them one-by-one as they come.
//
// Such approach doesn't seem to contradict with the XLSX specification
// because an `*.xlsx` files is supposed to be a normal `.zip` archive
// without any "trickery" such as "deleted" files or "garbage" data
// hiding under the hood.
//
// So when handling `*.xlsx` file, we assume that each such file must start
// with an individual file entry followed by another individual file entry, etc.
//
// When the "summary" section is reached, we assume that the archive has ended.
//
// To read a `.zip` archive, the code uses `fflate`'s `Unzip` class.
// The actual decompression could be performed either by using
// `fflate`'s pure-javascript `UnzipInflate` implementation, which is
// about 2x slower than Node.js's "native" module `zlib`,
// or it could use the aforementioned `zlib` module as a drop-in replacement
// (with some tinkering).
//
// The `Unzip` class doesn't speak the Node.js stream interface, and `fflate`'s readme
// doesn't include a clear "reading a `.zip` file from a Node.js stream" section.
// https://github.com/101arrowz/fflate/issues/251
// Instead, the `Unzip` class has its own `push(chunk)` / `onfile` / `entry.ondata` protocol.
// This code reads the binary input stream and forwards each chunk of it to `unzip.push()`,
// and then collects the decompressed file entries.
//
// P.S. In the comments to `UnzipInflate` in `fflate` package, it says:
// "Streaming DEFLATE decompression for ZIP archives. Prefer AsyncZipInflate for better performance."
// But there seems to be no `AsyncZipInflate` class in the `fflate` package.
// https://github.com/101arrowz/fflate/issues/277
// So just the regular `UnzipInflate` is used here.
//
import { Unzip, UnzipInflate, AsyncUnzipInflate } from '@deandret/rflate'

import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'

import UnzipError, { createUnzipError } from './UnzipError.js'

// Which `DEFLATE` decompressor to use by default:
//
// * "rflate" — `rflate`'s synchronous WebAssembly decompressor (`UnzipInflate`).
// * "rflate-async" — `rflate`'s decompressor running in worker threads (`AsyncUnzipInflate`).
// * "zlib" — Node.js's "native" `zlib` module, which decompresses asynchronously.
//
// The decompressors are compared in a benchmark:
//
// ```
// npm run test:benchmark:unzipFromStream
// ```
//
const DEFAULT_DECOMPRESSOR = 'rflate'

const PROMISE_RESOLVE_VALUE = undefined

/**
 * Reads `*.zip` file contents.
 * @param  {Stream} stream
 * @param  {function} onFile
 * @param  {function} onFileData
 * @param  {function} onFileDataEnd
 * @return {Promise<void>}
 */
export default function unzipFromStream_(stream, onFile, onFileData, onFileDataEnd) {
	return unzipFromStreamUsingDecompressor(stream, onFile, onFileData, onFileDataEnd, DEFAULT_DECOMPRESSOR)
}

/**
 * Reads `*.zip` file contents using a specific `DEFLATE` decompressor.
 * @param  {Stream} stream
 * @param  {function} onFile
 * @param  {function} onFileData
 * @param  {function} onFileDataEnd
 * @param  {'rflate' | 'rflate-async' | 'zlib'} decompressor
 * @return {Promise<void>}
 */
export function unzipFromStreamUsingDecompressor(stream, onFile, onFileData, onFileDataEnd, decompressor) {
	return new Promise((resolve, reject) => {
		let errored = false

		const onError = (error) => {
			// If `fflate` throws its specific error then it implies that the `.zip` file is not valid.
			//
			// By default, `fflate` uses it's own pure-js unzipper.
			// It could also be configured to use `node:zlib` native module instead.
			// In that case, it could throw a `code: "Z_DATA_ERROR"` too.
			//
			if (isFlateError(error) || error.code === 'Z_DATA_ERROR') {
				error = createUnzipError(error)
			}
			if (!errored) {
				errored = true
				reject(error)
			}
		}

		// The native `zlib` decoder finishes inflating an entry asynchronously, so
		// the archive's `end` event can fire while entries are still decompressing.
		// It counts "decompression still in-progress" entries the decompression for which
		// has started but not yet finished, and the main promise only resolves once
		// the input stream has ended *and* every entry is done decompressing.
		let stillDecompressingEntriesCount = 0
		let noMoreEntries = false
		const resolveIfDone = () => {
			if (!errored && noMoreEntries && stillDecompressingEntriesCount === 0) {
				resolve(PROMISE_RESOLVE_VALUE)
			}
		}

		const { validateChunk } = createZipFileValidator((isValid) => {
			if (!isValid) {
				onError(new UnzipError('INVALID_ZIP'))
			}
		})

		// `Unzip` discovers each individual file entry in the input data stream
		// and then calls the callback function for each such entry.
		const unzip = new Unzip((entry) => {
			// If there already was an error while reading this `.zip` file,
			// ignore any follow-up entries.
			if (errored) {
				return
			}

			// Skip directory entries (their names end with a slash).
			// Only files are of any interest.
			if (entry.name.endsWith('/')) {
				return
			}

			if (onFile(entry.name) === false) {
				return
			}

			stillDecompressingEntriesCount++

			// `entry.ondata` is called with each decompressed chunk of the entry,
			// and then a final time with `isLast === true` once the entry is complete.
			entry.ondata = (error, chunk, isLast) => {
				if (error) {
					return onError(error)
				}
				// Sometimes, `chunk` is a `Buffer`. Other times, it's a `Uint8Array`.
				// It's not really clear in which exact circumstances it's one or the other.
				if (chunk instanceof Buffer) {
					onFileData(entry.name, chunk)
				} else if (chunk instanceof Uint8Array) {
					onFileData(entry.name, Buffer.from(chunk))
				} else {
					// This error is not technically possible.
					// In case it is thrown, it means that there's a bug in the code.
					throw new Error('Unsupported type of chunk', chunk)
				}
				if (isLast) {
					stillDecompressingEntriesCount--
					onFileDataEnd(entry.name)
					resolveIfDone()
				}
			}

			// Start decompressing this entry.
			entry.start()
		})

		// Register the decompressor for the data that was compressed using
		// `DEFLATE` compression algorithm (compression method `8`),
		// which is what `.xlsx` files use.
		unzip.register(getDecompressor(decompressor))

		stream
			// Catch errors emitted from the input stream (for example, a file read error).
			.on('error', onError)
			// When another chunk of data is read from the input stream.
			.on('data', (chunk) => {
				// If there already was an error while reading this `.zip` file,
				// ignore any follow-up data chunks.
				if (errored) {
					return
				}
				// Validate the `.zip` archive as its data comes through.
				validateChunk(chunk)
				// If the `.zip` archive is found to be invalid, stop any further
				// processing of it.
				if (errored) {
					return
				}
				// Push the next data chunk to `fflate`'s `Unzip` class instance.
				//
				// The `.push()` function of `fflate`'s own `ZipInflate` decompressor is synchronous,
				// meaning that by the time it returns, any complete files entries encountered so far
				// have already been decompressed and populated in the `files` object.
				//
				// The `.push()` function of `NativeZlibInflate` decompressor is asynchronous,
				// so it requires hacking around with the counter of "still being decompressed" entries
				// in order to detect the actual finish of the archive's decompression process.
				//
				try {
					unzip.push(chunk, false)
				} catch (error) {
					onError(error)
				}
			})
			// When there's no more data in the input stream to consume,
			// finish reading the `.zip` archive.
			.on('end', () => {
				// If there were any errors when reading the `.zip` archive,
				// don't `resolve()` with anything.
				if (errored) {
					return
				}
				try {
					// Signal the end of the archive to `fflate`'s `Unzip` class instance.
					// It will flush any remaining state in it.
					unzip.push(new Uint8Array(0), true)
					// The input stream has ended.
					noMoreEntries = true
					// The entries may still be decompressing asynchronously.
					// In that case, resolve once they all finish decompresssing.
					// Or, resolve if all entries have already finished decompressing by now.
					resolveIfDone()
				} catch (error) {
					onError(error)
				}
			})
	})
}

// Every section in a `.zip` archive is marked with 4 bytes, the first two of which
// are `0x50` and `0x4B`, which reads "PK", referencing the initials of the inventor Phil Katz.
//
// It looks like `fflate`'s `Unzip` doesn't ever complain about whatever data is thrown at it.
// Due to how `.zip` file format is defined, "garbage" data could be placed at various
// places in it and it'd still be a valid `.zip` archive. It's likely that for this reason
// `fflate` doesn't ever complain and simply emits no entries when fed any kind of invalid data.
//
// In order to introduce some basic validation, here we specifically demand
// that a `.zip` archive must at least start with an individual file entry
// because an `.xlsx` file creator softwared really shouldn't attempt doing
// anything "funny" when writing a file, hence this adherence requirement.
//
function createZipFileValidator(onValidationResult) {
	const firstBytesCount = 4
	const firstBytes = []
	return {
		validateChunk(chunk) {
			if (firstBytes.length < firstBytesCount) {
				let i = 0
				while (i < chunk.length && firstBytes.length < firstBytesCount) {
					firstBytes.push(chunk[i])
					i++
				}
				if (firstBytes.length === firstBytesCount) {
					// `PK\x03\x04` starts a file entry.
					// `PK\x05\x06` starts the "summary" section of an archive that has no files.
					const isValid = firstBytes[0] === 0x50 && firstBytes[1] === 0x4B && (
						(firstBytes[2] === 0x03 && firstBytes[3] === 0x04) ||
						(firstBytes[2] === 0x05 && firstBytes[3] === 0x06)
					)
					onValidationResult(isValid)
				}
			}
		}
	}
}

function getDecompressor(name) {
	switch (name) {
		case 'zlib':
			return NativeZlibInflate
		case 'rflate-async':
			return AsyncUnzipInflate
		case 'rflate':
			return UnzipInflate
		default:
			throw new Error(`Unknown decompressor: ${name}`)
	}
}

// An implemenation of a `DEFLATE` decompressor for `fflate`'s `Unzip` class
// that uses Node.js's "native" module `zlib`.
//
// It implements `fflate`'s decoder interface: `Unzip` constructs one decoder
// per each entry, sets `ondata(error, chunk, isLast)` callback on it, and feeds it
// the entry's compressed bytes by calling `push(chunk, isLast)` method.
//
// Unlike `fflate`'s synchronous `UnzipInflate` decoder, `zlib` decompresses asynchronously,
// so an entry only finishes some "ticks" after its last chunk of its data is `push()`ed
// by `fflate`'s `Unzip` class. To work around this issue, pending entries counter is used
// to track when the archive really finishes unpacking.
//
class NativeZlibInflate {
	static compression = 8

	constructor() {
		this.inflate = zlib.createInflateRaw()
		this.inflate.on('data', (chunk) => this.ondata(null, chunk, false))
		this.inflate.on('end', () => this.ondata(null, new Uint8Array(0), true))
		this.inflate.on('error', (error) => this.ondata(error, null, false))
	}

	push(chunk, isLast) {
		this.inflate.write(Buffer.from(chunk))
		if (isLast) {
			this.inflate.end()
		}
	}

	terminate() {
		this.inflate.destroy()
	}
}

// This function attempts to guess if a given `error` was thrown by `fflate`.
function isFlateError(error) {
	// `fflate` doesn't export a `FlateError` class.
	// https://github.com/101arrowz/fflate/issues/290
	// return error instanceof FlateError

	// Here, it attempts to guess if an `error` is a `FlateError` by checking if `error.code` is a `number`.
	return typeof error.code === 'number'
}
