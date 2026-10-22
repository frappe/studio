import fs from "fs"
import path from "path"

/**
 * Studio folders of apps installed from a checkout outside `apps/`.
 *
 * `frappe.get_app_source_path` resolves an app through the Python environment, so for an app
 * installed from elsewhere (e.g. a git worktree) the API hands the editor paths under that
 * checkout. bench records such a checkout as a `.pth` file in the venv's site-packages. Reading
 * the same registry keeps `server.fs.allow` in step with the paths the API advertises, while
 * still allowing only each checkout's `studio/` folder.
 */
export default function pthAppStudioDirs(benchDir) {
	const libDir = path.join(benchDir, "env", "lib")
	return listDir(libDir)
		.map((pythonDir) => path.join(libDir, pythonDir, "site-packages"))
		.flatMap(listPthFiles)
		.flatMap(readSourcePaths)
		.flatMap(resolveStudioDir)
}

// Vite checks fs.allow against real paths, so resolve symlinks like appSymlinkedSources does
function resolveStudioDir(source) {
	try {
		const studioDir = fs.realpathSync(path.join(source, "studio"))
		return fs.statSync(studioDir).isDirectory() ? [studioDir] : []
	} catch {
		return []
	}
}

function listPthFiles(sitePackages) {
	return listDir(sitePackages)
		.filter((entry) => entry.endsWith(".pth"))
		.map((entry) => path.join(sitePackages, entry))
}

// A .pth line is either a directory to add to sys.path or an `import ...` statement
function readSourcePaths(pthFile) {
	try {
		return fs
			.readFileSync(pthFile, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => path.isAbsolute(line))
	} catch {
		return []
	}
}

function listDir(dir) {
	try {
		return fs.readdirSync(dir)
	} catch {
		return []
	}
}
