// `unzipFromStream` function reads `.zip` archive data from a Node.js stream.
//
// Even though it receives a Node.js stream as an input, it doesn't return the results
// as a Node.js output stream (with `objectMode: true` setting). The reason is that
// the result of this function is then passed to the XML parser which currently
// doesn't support consuming a Node.js stream and instead consumes the entire XML document
// as a single string. This means that implementing streaming output in this function
// wouldn't result in any performance improvements, so currently it simply returns
// a "map" of all files in the input `.zip` archive, and that seems to be enough.
//
// Currently, there're two `.zip` reader implementations:
// * `rflate` — uses `rflate` package: `fflate`'s `.zip` reader with a `DEFLATE` decompressor
//   written in Rust and compiled to WebAssembly. It could also use Node's `zlib` instead.
// * `unzipper` — uses `unzipper-esm` package that uses Node's "native" `zlib` which is written in C.
//   It is only kept for the benchmark: see `test/benchmark-unzipFromStream`.
//
// The implementations are compared in a benchmark:
//
// ```
// npm run test:benchmark:unzipFromStream
// ```
//
// The benchmark tells that `rflate` is about 2.5x faster than `unzipper`:
//
// * When decompressing a `1 MB` `.xlsx` file, the decompression time is `40 ms`
//   when using `rflate` and `115 ms` when using `unzipper`.
// * When decompressing a `10 MB` `.xlsx` file, the decompression time is `150 ms`
//   when using `rflate` and `430 ms` when using `unzipper`.
// * When decompressing a `50 MB` `.xlsx` file, the decompression time is `1400 ms`
//   when using `rflate` and `3500 ms` when using `unzipper`.
//
// `rflate` with Node's `zlib` decompressor is about as fast as `unzipper`, and `rflate`
// with its decompressor running in worker threads is 2x slower on a `1 MB` file
// and 2x faster on a `50 MB` one.
//
// So `rflate` is used. Things to know about it when compared to `unzipper`:
//
// * `unzipper` is designed around the concept of Node.js streams "from the ground up".
//   Meanwhile, `fflate`'s (and `rflate`'s) `Unzip` class does not implement Node.js streams
//   "contract", i.e. it just unzips the archive as fast as it can consume it from the input stream.
//   Since the decompressor is synchronous, each chunk of the input is fully processed
//   before the next one is read, so the input is not buffered in RAM.
//
// * Rumors are circulating that `fflate`'s "streaming" `Zip`/`Unzip` classes have a few
//   implementation issues when compared to non-"streaming" `zipSync`/`unzipSync`/`zip`/`unzip` functions.
//   https://github.com/101arrowz/fflate/issues/282
//
import unzipFromStream_ from './unzipFromStream.rflate.js'

/**
 * Reads `*.zip` file contents.
 * @param  {Stream} stream
 * @return {Promise<Record<string,Buffer>>} Resolves to an object holding `*.zip` file entries. P.S. `Buffer` is a `Uint8Array`.
 */
export default function unzipFromStream(stream, { filter } = {}) {
	// The `files` object stores the files and their contents.
	const files = {}
	const filesData = {}

	const onFile = (filePath) => {
		// See if this file should be ignored.
		// If it should, this entry won't be processed, i.e. `Unzip` will not try
		// to decompress its data, and will just discard it.
		if (filter && !filter({ path: filePath })) {
			return false
		}
		// The uncompressed size of the file that is declared in the archive is not used
		// to allocate the buffer for the file in advance because it can't be trusted:
		// a tiny malformed archive could declare that one of its files is gigabytes in size.
		// https://github.com/101arrowz/fflate/issues/311
		// Instead, it collects the chunks of data and then allocates a buffer
		// for the data that has actually been received.
		filesData[filePath] = []
	}

	const onFileData = (filePath, chunk) => {
		filesData[filePath].push(chunk)
	}

	const onFileDataEnd = (filePath) => {
		files[filePath] = concatChunksToNonPooledBuffer(filesData[filePath])
		delete filesData[filePath]
	}

	return unzipFromStream_(stream, onFile, onFileData, onFileDataEnd)
		.then(() => files)
}

// // Node.js allocates small buffers (<= 4KB) in a shared 8KB pool.
// // This interferes with passing such buffers to another worker thread.
// // In order for a buffer to be transferrable to another worker thread,
// // it has to be non-pooled.
// function isBufferPooled(buffer) {
// 	// If it doesn't utilize the full underlying `ArrayBuffer`, it's sliced out of a pool.
// 	if (buffer.byteOffset > 0) {
// 		return true
// 	}
//
// 	// If it starts at `0`, but the underlying allocation is larger than the buffer itself, it's pooled/
// 	if (buffer.buffer.byteLength > buffer.byteLength) {
// 		return true
// 	}
//
// 	return false
// }

// Concatenates chunks into a non-"pooled" buffer.
//
// It could've simply used `Buffer.concat(chunks)` to concatenate chunks into a buffer.
// But, while using `Buffer.concat()` is simple, it results in a Node.js optimization
// when it uses a "shared" memory region of about `8KB` to co-locate this array buffer
// with other small array buffers if this array buffer is small too (i.e. <= `4KB`).
//
// Such co-location results in the inability to "transfer" this buffer
// to a worker thread.
//
// A workaround is to manually allocate a separate memory region of a certain size.
// This way, the resulting buffer will be non-"pooled".
//
function concatChunksToNonPooledBuffer(chunks) {
	// Calculate the total byte length of all the chunks combined.
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)

	// Allocate a non-pooled buffer.
	// Here it uses `Buffer.allocUnsafeSlow()` instead of the regular `Buffer.alloc()`.
	// The reason is that `Buffer.allocUnsafeSlow()` doesn't bother resetting the memory
	// that is being allocated, which is fine because it will be overwritten anyway.
	// It could also have used `Buffer.allocUnsafe()` if it wasn't returning pooled buffers,
	// which is what is being avoided here in the first place.
	const buffer = Buffer.allocUnsafeSlow(totalLength)

	// Manually copy each chunk into the buffer.
	let offset = 0
	for (const chunk of chunks) {
		chunk.copy(buffer, offset)
		offset += chunk.length
	}

	return buffer
}