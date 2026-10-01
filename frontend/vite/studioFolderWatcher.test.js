import test from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import studioFolderWatcher from "./studioFolderWatcher.js"

function setup() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watcher-")))
	const appsDir = path.join(root, "bench", "apps")
	const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true })
	mk(appsDir, "inside", "studio")
	mk(appsDir, "studio", "studio")
	mk(root, "outside", "studio")
	return { root, appsDir }
}

// A watched folder is one whose files hotUpdate swallows (create/delete -> [])
const isWatched = (plugin, file) => plugin.hotUpdate({ type: "create", file, modules: [] })?.length === 0

test("watches studio dirs outside apps/ when passed in", () => {
	const { root, appsDir } = setup()
	const plugin = studioFolderWatcher(appsDir, [path.join(root, "outside", "studio")])
	assert.ok(isWatched(plugin, path.join(root, "outside", "studio", "a", "x.vue")))
	assert.ok(isWatched(plugin, path.join(appsDir, "inside", "studio", "x.vue")))
})

test("without extra dirs, outside apps/ is not watched (previous behaviour)", () => {
	const { root, appsDir } = setup()
	const plugin = studioFolderWatcher(appsDir)
	assert.ok(!isWatched(plugin, path.join(root, "outside", "studio", "x.vue")))
})

test("does not start watching studio's own python package dir", () => {
	const { appsDir } = setup()
	const plugin = studioFolderWatcher(appsDir, [path.join(appsDir, "studio", "studio")])
	assert.ok(!isWatched(plugin, path.join(appsDir, "studio", "studio", "x.vue")))
})

test("symlinked apps/studio: its real package dir is neither watched nor swallowed", () => {
	const { root, appsDir } = setup()
	fs.rmSync(path.join(appsDir, "studio"), { recursive: true })
	const worktree = path.join(root, "worktree")
	fs.mkdirSync(path.join(worktree, "studio"), { recursive: true })
	fs.symlinkSync(worktree, path.join(appsDir, "studio"))
	const plugin = studioFolderWatcher(appsDir, [path.join(worktree, "studio")])
	assert.ok(!isWatched(plugin, path.join(worktree, "studio", "x.vue")))
	assert.ok(!isWatched(plugin, path.join(appsDir, "studio", "studio", "x.vue")))
})

test("symlinked ordinary app matches events by real path and by symlink path, watched once", () => {
	const { root, appsDir } = setup()
	const real = path.join(root, "linked")
	fs.mkdirSync(path.join(real, "studio"), { recursive: true })
	fs.symlinkSync(real, path.join(appsDir, "linked"))
	const plugin = studioFolderWatcher(appsDir, [path.join(real, "studio")])
	assert.ok(isWatched(plugin, path.join(real, "studio", "x.vue")))
	assert.ok(isWatched(plugin, path.join(appsDir, "linked", "studio", "x.vue")))
	const added = []
	const handlers = {}
	plugin.configureServer({
		ws: { send() {} },
		watcher: { add: (f) => added.push(f), on: (e, h) => (handlers[e] = h) },
	})
	assert.equal(added.length, 2) // "inside" and "linked", the latter once despite two path forms
})

test("symlinked app with NO extras still matches events by real path", () => {
	const { root, appsDir } = setup()
	const real = path.join(root, "linked")
	fs.mkdirSync(path.join(real, "studio"), { recursive: true })
	fs.symlinkSync(real, path.join(appsDir, "linked"))
	const plugin = studioFolderWatcher(appsDir)
	assert.ok(isWatched(plugin, path.join(real, "studio", "x.vue")))
	assert.ok(isWatched(plugin, path.join(appsDir, "linked", "studio", "x.vue")))
})

// Live chokidar: Vite may also watch an imported real file outside root next to our folder watch
test("live chokidar: alias folder + real file watched emits studio:file-changed once", async () => {
	const { default: chokidar } = await import("chokidar")
	const { root, appsDir } = setup()
	const real = path.join(root, "linked")
	fs.mkdirSync(path.join(real, "studio", "p"), { recursive: true })
	const file = path.join(real, "studio", "p", "a.ts")
	fs.writeFileSync(file, "1")
	fs.symlinkSync(real, path.join(appsDir, "linked"))
	const plugin = studioFolderWatcher(appsDir)
	const watcher = chokidar.watch([], { ignoreInitial: true })
	const events = []
	plugin.configureServer({ ws: { send: (m) => events.push(m) }, watcher })
	watcher.add(file) // what Vite's ensureWatchedFile does for an imported real file
	await new Promise((r) => setTimeout(r, 500))
	fs.writeFileSync(file, "2")
	await new Promise((r) => setTimeout(r, 1000))
	await watcher.close()
	const changed = events.filter((e) => e.event === "studio:file-changed")
	assert.equal(changed.length, 1, JSON.stringify(changed))
})
