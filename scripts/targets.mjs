// Single source of truth for the 12 release targets.
export const BUN_VERSION = "1.4.2";

const RUNNERS = {
	"macos-15-intel": ["darwin", "x64"],
	"macos-15": ["darwin", "arm64"],
	"ubuntu-24.04": ["linux", "x64"],
	"ubuntu-24.04-arm": ["linux", "arm64"],
	"windows-2022": ["windows", "x64"],
	"windows-11-arm": ["windows", "arm64"],
};

// Pinned native musl userspace: oven/bun:1.4.2-alpine (Alpine 3.22), so musl builds run BUN_VERSION too.
// The previous pins carried Bun 1.4.0, whose musl createRequire hands a replaced
// Module._resolveFilename no parent and broke every plugin's relative createRequire.
const MUSL_IMAGES = {
	x64: "docker.io/oven/bun@sha256:d73746a3e6cd8de6d7abff1c4c678028b6fe25e0c39808f9a71214589fa8b023",
	arm64: "docker.io/oven/bun@sha256:df7bf53d29008d89d195925aad82ca7e51dad114c6cd65b32cf8c3e0c186bb30",
};

const ZIG_ARCH = { x64: "x86_64", arm64: "aarch64" };
const NODE_OS = { linux: "linux", darwin: "darwin", windows: "win32" };

function t(id, os, arch, libc, cpu, runner) {
	const [ros, rarch] = RUNNERS[runner];
	if (ros !== os || rarch !== arch) throw new Error(`runner ${runner} does not match ${id}`);
	const muslSuffix = libc === "musl" ? "-musl" : "";
	const baselineSuffix = cpu === "baseline" ? "-baseline" : cpu === "modern" ? "-modern" : "";
	return Object.freeze({
		id,
		os,
		arch,
		libc,
		cpu,
		runner,
		nodePlatform: NODE_OS[os],
		bunTarget: `bun-${os}-${arch}${muslSuffix}${baselineSuffix}`,
		zigTarget: `${ZIG_ARCH[arch]}-${os === "darwin" ? "macos" : os}${os === "linux" ? `-${libc}` : os === "windows" ? "-gnu" : ""}`,
		// pnpm official GitHub release asset; only its platform-neutral dist/ is kept.
		// pnpm ships no darwin-x64 asset: reuse darwin-arm64 dist/, drop its arm64
		// reflink package and add reflink.darwin-x64.node from pnpm/reflink.
		pnpmAsset: `pnpm-${NODE_OS[os]}-${os === "darwin" ? "arm64" : arch}${libc === "musl" ? "-musl" : ""}.${os === "windows" ? "zip" : "tar.gz"}`,
		...(os === "darwin" && arch === "x64"
			? { pnpmDrop: ["dist/node_modules/@reflink/reflink-darwin-arm64"], reflinkAsset: "reflink.darwin-x64.node" }
			: {}),
		executable: os === "windows" ? "dsh-native.exe" : "dsh-native",
		launcher: os === "windows" ? "dsh.exe" : "dsh",
		archive: `dsh-${id}.zip`,
		...(libc === "musl" ? { containerImage: MUSL_IMAGES[arch] } : {}),
	});
}

export const TARGETS = Object.freeze([
	t("linux-x64-baseline", "linux", "x64", "gnu", "baseline", "ubuntu-24.04"),
	t("linux-x64-modern", "linux", "x64", "gnu", "modern", "ubuntu-24.04"),
	t("linux-arm64", "linux", "arm64", "gnu", "arm64", "ubuntu-24.04-arm"),
	t("linux-x64-musl-baseline", "linux", "x64", "musl", "baseline", "ubuntu-24.04"),
	t("linux-x64-musl-modern", "linux", "x64", "musl", "modern", "ubuntu-24.04"),
	t("linux-arm64-musl", "linux", "arm64", "musl", "arm64", "ubuntu-24.04-arm"),
	t("darwin-x64-baseline", "darwin", "x64", null, "baseline", "macos-15-intel"),
	t("darwin-x64-modern", "darwin", "x64", null, "modern", "macos-15-intel"),
	t("darwin-arm64", "darwin", "arm64", null, "arm64", "macos-15"),
	t("windows-x64-baseline", "windows", "x64", null, "baseline", "windows-2022"),
	t("windows-x64-modern", "windows", "x64", null, "modern", "windows-2022"),
	t("windows-arm64", "windows", "arm64", null, "arm64", "windows-11-arm"),
]);

export function target(id) {
	const found = TARGETS.find((x) => x.id === id);
	if (!found) throw new Error(`unknown target: ${id}`);
	return found;
}

/** Target of the current host (glibc/modern by default). */
export function hostTargetId() {
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch;
	if (arch === "arm64") return os === "linux" && isMusl() ? "linux-arm64-musl" : `${os}-arm64`;
	return os === "linux" && isMusl() ? "linux-x64-musl-modern" : `${os}-x64-modern`;
}

function isMusl() {
	try {
		return !process.report?.getReport()?.header?.glibcVersionRuntime;
	} catch {
		return false;
	}
}

export const githubMatrix = () => ({ include: TARGETS.map(({ id, runner, containerImage }) => ({ id, runner, ...(containerImage ? { containerImage } : {}) })) });

if (import.meta.main) {
	const [cmd, id, field] = process.argv.slice(2);
	if (cmd === "--ids") console.log(TARGETS.map((x) => x.id).join("\n"));
	else if (cmd === "--matrix") console.log(JSON.stringify(githubMatrix()));
	else if (cmd === "--host") console.log(hostTargetId());
	else if (cmd === "--get") console.log(target(id)[field] ?? "");
	else throw new Error("usage: targets.mjs --ids | --matrix | --host | --get <id> <field>");
}
