import fs from 'node:fs'

import { unzipFromStreamUsingDecompressor } from '../../source/zip/unzipFromStream.rflate.js'
import unzipFromStreamUsingUnzipper from './unzipFromStream.unzipper.js'

const IMPLEMENTATIONS =  [{
	name: 'rflate',
	unzipFromStream: (...args) => unzipFromStreamUsingDecompressor(...args, 'rflate')
}, {
	name: 'rflate (async)',
	unzipFromStream: (...args) => unzipFromStreamUsingDecompressor(...args, 'rflate-async')
}, {
	name: 'rflate (zlib)',
	unzipFromStream: (...args) => unzipFromStreamUsingDecompressor(...args, 'zlib')
}, {
	name: 'unzipper',
	unzipFromStream: unzipFromStreamUsingUnzipper
}]

const ARCHIVES = ['1mb', '10mb', '50mb']

// Each implementation is run several times, taking turns, and the median time is reported.
const RUNS = 5

const noop = () => {}

describe('unzipFromStream (benchmark)', function() {
	this.timeout(0)

	it('should compare different implementations', async () => {
		for (const archiveName of ARCHIVES) {
			const filePath = `./test/benchmark/${archiveName}.xlsx`
			if (!fs.existsSync(filePath)) {
				console.log('skipped', archiveName, '(file not found)')
				continue
			}
			const times = IMPLEMENTATIONS.map(() => [])
			// The first round is a warm-up.
			for (let run = 0; run <= RUNS; run++) {
				for (let i = 0; i < IMPLEMENTATIONS.length; i++) {
					const stream = fs.createReadStream(filePath)
					const startedAt = performance.now()
					await IMPLEMENTATIONS[i].unzipFromStream(stream, noop, noop, noop)
					if (run > 0) {
						times[i].push(performance.now() - startedAt)
					}
				}
			}
			for (let i = 0; i < IMPLEMENTATIONS.length; i++) {
				const median = times[i].sort((a, b) => a - b)[Math.floor(RUNS / 2)]
				console.log(IMPLEMENTATIONS[i].name, 'read', archiveName, 'in', Math.round(median), 'ms')
			}
		}
	})
})
