import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import pthAppStudioDirs from "./pthAppSources.js"

describe("pthAppStudioDirs", () => {
	let bench

	beforeEach(() => {
		bench = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-pth-")))
	})
	afterEach(() => fs.rmSync(bench, { recursive: true, force: true }))

	const sitePackages = () => {
		const dir = path.join(bench, "env", "lib", "python3.14", "site-packages")
		fs.mkdirSync(dir, { recursive: true })
		return dir
	}
	const checkout = (name, { studio = true } = {}) => {
		const dir = path.join(bench, "elsewhere", name)
		fs.mkdirSync(studio ? path.join(dir, "studio") : dir, { recursive: true })
		return dir
	}

	it("returns the studio folder of a checkout registered through a .pth file", () => {
		const app = checkout("helpdesk")
		fs.writeFileSync(path.join(sitePackages(), "helpdesk.pth"), `${app}\n`)
		assert.deepEqual(pthAppStudioDirs(bench), [path.join(app, "studio")])
	})

	it("skips import lines, relative lines, blank lines and checkouts without studio/", () => {
		const withStudio = checkout("a")
		const withoutStudio = checkout("b", { studio: false })
		// a relative path that exists from the working directory must still be ignored
		const relative = path.relative(process.cwd(), checkout("rel"))
		assert.ok(fs.existsSync(path.join(relative, "studio")))
		fs.writeFileSync(
			path.join(sitePackages(), "mixed.pth"),
			["import sys; sys.path.insert(0, 'x')", "", relative, withoutStudio, `  ${withStudio}  `].join("\r\n"),
		)
		assert.deepEqual(pthAppStudioDirs(bench), [path.join(withStudio, "studio")])
	})

	it("scans every python version directory", () => {
		const first = checkout("py-a")
		const second = checkout("py-b")
		for (const [version, app] of [["python3.12", first], ["python3.14", second]]) {
			const dir = path.join(bench, "env", "lib", version, "site-packages")
			fs.mkdirSync(dir, { recursive: true })
			fs.writeFileSync(path.join(dir, "app.pth"), app)
		}
		assert.deepEqual(pthAppStudioDirs(bench).sort(), [path.join(first, "studio"), path.join(second, "studio")].sort())
	})

	it("resolves a symlinked checkout to its real studio folder", () => {
		const real = checkout("real")
		const link = path.join(bench, "elsewhere", "link")
		fs.symlinkSync(real, link)
		fs.writeFileSync(path.join(sitePackages(), "linked.pth"), link)
		assert.deepEqual(pthAppStudioDirs(bench), [fs.realpathSync(path.join(real, "studio"))])
	})

	it("ignores a regular file named studio", () => {
		const app = checkout("file-studio", { studio: false })
		fs.writeFileSync(path.join(app, "studio"), "")
		fs.writeFileSync(path.join(sitePackages(), "file.pth"), app)
		assert.deepEqual(pthAppStudioDirs(bench), [])
	})

	it("ignores files that are not .pth", () => {
		const app = checkout("c")
		fs.writeFileSync(path.join(sitePackages(), "notes.txt"), app)
		assert.deepEqual(pthAppStudioDirs(bench), [])
	})

	it("returns nothing when the bench has no env", () => {
		assert.deepEqual(pthAppStudioDirs(bench), [])
	})
})
