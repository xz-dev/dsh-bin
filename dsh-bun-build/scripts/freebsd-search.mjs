// Fixed rc.2 search component. Assembly consumes the separately retained build receipt.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { binaryArch, isFreebsdElf } from "./binary-arch.mjs";

export const SEARCH_SOURCE = Object.freeze({
  packageVersion: "1.18.0", wrapperCommit: "d22dec46c67fc8c5d307c9b18dba2792efd1f016",
  prebuiltCommit: "67202aaafb17aecd9b5b7046d5b7baa92b05237a", prebuiltTag: "v15.0.1",
  version: "15.0.0", commit: "3a612f88b805e14aef45bfa43e25a54abc6297fc",
  archiveSha256: "f30f2ff3bc91df5750d7a341088862559f1447f7bc278a69e5daf532c71b8e8d",
  patchSha256: "45f8b58bba714c446de407f93120f557736b45fad6f43ea283077201646a1be7",
  lockSha256: "b70eba44305c42f89e817df90e1ed66710ee4638a908410105e9cc459f7c73e8",
  rust: "1.88.0", pcre2: "10.45",
});
// Derived source+vendor archive retained with the authenticated primary inputs.
export const SEARCH_BUILD_INPUTS = Object.freeze({
  "source-vendor.tar.gz": "42098dbf74c70c231bfa960a59917d175f745eca157586d77d52c293f9f0c28c",
  "rustc-1.88.0-x86_64-unknown-freebsd.tar.xz": "c73b12a183b9fbc044d6ce946edbc292cc0abd9a0485d4101c1312aa43235354",
  "rust-std-1.88.0-x86_64-unknown-freebsd.tar.xz": "87fce9a016f8636e0f6b7a3e624837f5afbbf17e321de11fc24b87f447f04729",
  "cargo-1.88.0-x86_64-unknown-freebsd.tar.xz": "32f79c7c9534d89d528c2457148bd82bcc5b025b7a40526f39dedaab097d4261",
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const packageName = arch => `@vscode/ripgrep-freebsd-${arch}`;
const checkArch = arch => { if (!["x64", "arm64"].includes(arch)) throw new Error("search architecture must be x64|arm64"); };

function inspect(binary, arch) {
  checkArch(arch);
  const bytes = readFileSync(binary);
  if (!isFreebsdElf(bytes) || binaryArch(bytes).arch !== arch || ![2, 3].includes(bytes.readUInt16LE(16))) throw new Error("search requires matching genuine FreeBSD executable ELF");
  const result = spawnSync("/usr/bin/readelf", ["-h", "-l", "-S", "-d", "-n", "--wide", binary], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 30_000 });
  if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error(`invalid search ELF: ${result.stderr || result.error}`);
  const text = result.stdout;
  if (!/^\s*LOAD\s/m.test(text) || !/^\s*DYNAMIC\s/m.test(text) || !text.includes("[Requesting program interpreter: /libexec/ld-elf.so.1]")) throw new Error("search executable load/dynamic/interpreter structure missing");
  if (/\((?:RPATH|RUNPATH)\)/.test(text)) throw new Error("search ELF must not load libraries from external paths");
  const dependencies = [...text.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(match => match[1]).sort();
  if (JSON.stringify(dependencies) !== '["libc.so.7","libgcc_s.so.1","libthr.so.3"]') throw new Error("search requires verified 15.1 base DT_NEEDED only");
  return dependencies;
}

// expected is trusted OUTSIDE this package, never read from its own metadata.
export function verifyFreebsdSearchPackage(directory, arch, expected) {
  checkArch(arch);
  if (expected?.platform !== `freebsd-${arch}` || ![expected?.sha256, expected?.receiptSha256].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) throw new Error("independently trusted search build receipt required");
  if (JSON.stringify(readdirSync(directory).sort()) !== '["LICENSE","bin","build-receipt.json","package.json"]' || !lstatSync(join(directory, "bin")).isDirectory() || JSON.stringify(readdirSync(join(directory, "bin"))) !== '["rg"]') throw new Error("search package must contain only its fixed payload and metadata");
  for (const file of ["bin/rg", "package.json", "build-receipt.json", "LICENSE"]) if (!lstatSync(join(directory, file)).isFile()) throw new Error("search package requires regular files, not symlinks");
  const binary = join(directory, "bin/rg"), receiptBytes = readFileSync(join(directory, "build-receipt.json"));
  if (hash(readFileSync(binary)) !== expected.sha256 || hash(receiptBytes) !== expected.receiptSha256) throw new Error("search trusted artifact identity mismatch");
  const receipt = JSON.parse(receiptBytes), meta = json(join(directory, "package.json"));
  const expectedMeta = { name: packageName(arch), version: SEARCH_SOURCE.packageVersion, os: ["freebsd"], cpu: [arch], license: "MIT", files: ["bin/", "build-receipt.json", "LICENSE"] };
  if (JSON.stringify(meta) !== JSON.stringify(expectedMeta)) throw new Error("search package identity mismatch (including resolver metadata)");
  if (JSON.stringify(receipt.source) !== JSON.stringify(SEARCH_SOURCE) || JSON.stringify(receipt.inputs) !== JSON.stringify(SEARCH_BUILD_INPUTS) || receipt.platform !== expected.platform || receipt.sha256 !== expected.sha256 || receipt.compiler !== "/usr/bin/cc" || receipt.freebsdVersion !== "15.1-RELEASE") throw new Error("search fixed source/build identity mismatch");
  const dependencies = inspect(binary, arch);
  if (JSON.stringify(receipt.dependencies) !== JSON.stringify(dependencies)) throw new Error("search actual dependencies differ from build receipt");
  return receipt;
}

/** Copy only. Preserve public JS and every existing prebuild byte. */
export function stageFreebsdSearch(sourceApp, outputApp, arch, component, expected) {
  const receipt = verifyFreebsdSearchPackage(component, arch, expected);
  const source = realpathSync(sourceApp), output = join(realpathSync(dirname(resolve(outputApp))), basename(outputApp));
  if (existsSync(output) || output === source || output.startsWith(`${source}${sep}`)) throw new Error("search staging requires a new independent app copy");
  const entry = join(source, "node_modules/@vscode/ripgrep");
  const meta = json(join(entry, "package.json"));
  if (hash(readFileSync(join(entry, "package.json"))) !== "215d02d16768da13248a4a79bc999d51b6629222f36b83b2a7cf0479fecc9618" || meta.version !== SEARCH_SOURCE.packageVersion || hash(readFileSync(join(entry, "lib/index.js"))) !== "107cf2aa0eaf6e9fb1a23cfe74cdbd322b1628af1812d05d9d46b650c4cc4c5d") throw new Error("certified ripgrep wrapper required");
  if (existsSync(join(source, "node_modules", packageName(arch)))) throw new Error("FreeBSD search package already present");
  cpSync(source, output, { recursive: true });
  const destination = join(output, "node_modules", packageName(arch));
  mkdirSync(join(destination, "bin"), { recursive: true });
  for (const file of ["bin/rg", "package.json", "build-receipt.json", "LICENSE"]) cpSync(join(component, file), join(destination, file));
  meta.optionalDependencies = { ...meta.optionalDependencies, [packageName(arch)]: SEARCH_SOURCE.packageVersion };
  save(join(output, "node_modules/@vscode/ripgrep/package.json"), meta);
  return receipt;
}

/** Native amd64 only: upstream Rust 1.88 has no distributed ARM64 FreeBSD std. */
export function buildFreebsdSearch(inputs, work) {
  if (process.platform !== "freebsd" || process.arch !== "x64") throw new Error("native amd64 FreeBSD required; ARM64 toolchain is blocked, no bootstrap/fallback");
  if (!isAbsolute(work) || existsSync(work)) throw new Error("search build requires new absolute task work directory");
  for (const [file, digest] of Object.entries(SEARCH_BUILD_INPUTS)) if (hash(readFileSync(join(inputs, file))) !== digest) throw new Error(`search build input hash mismatch: ${file}`);
  mkdirSync(work, { recursive: true });
  const run = (file, args, options = {}) => execFileSync(file, args, { cwd: work, timeout: 300_000, ...options });
  const toolchain = join(work, "toolchain");
  for (const name of ["rustc", "rust-std", "cargo"]) {
    const stem = `${name}-1.88.0-x86_64-unknown-freebsd`;
    run("/usr/bin/tar", ["-xf", join(resolve(inputs), `${stem}.tar.xz`)]);
    run("/bin/sh", [join(work, stem, "install.sh"), `--prefix=${toolchain}`, "--disable-ldconfig"]);
  }
  run("/usr/bin/tar", ["-xf", join(resolve(inputs), "source-vendor.tar.gz")]);
  const source = join(work, "ripgrep");
  if (hash(readFileSync(join(source, "Cargo.lock"))) !== SEARCH_SOURCE.lockSha256) throw new Error("search Cargo.lock changed");
  const env = { HOME: join(work, "home"), TMPDIR: join(work, "tmp"), CARGO_HOME: join(work, "cargo-home"), PATH: `${toolchain}/bin:/usr/bin:/bin:/sbin`, CC: "/usr/bin/cc", PCRE2_SYS_STATIC: "1", CARGO_PROFILE_RELEASE_DEBUG: "0" };
  for (const key of ["HOME", "TMPDIR", "CARGO_HOME"]) mkdirSync(env[key], { recursive: true });
  run(join(toolchain, "bin/cargo"), ["build", "--offline", "--locked", "--release", "--features", "pcre2", "--target", "x86_64-unknown-freebsd"], { cwd: source, env, stdio: "inherit" });
  const binary = join(source, "target/x86_64-unknown-freebsd/release/rg"), dependencies = inspect(binary, "x64");
  const directory = join(work, "component");
  mkdirSync(join(directory, "bin"), { recursive: true });
  cpSync(binary, join(directory, "bin/rg"));
  chmodSync(join(directory, "bin/rg"), 0o755);
  cpSync(join(source, "LICENSE-MIT"), join(directory, "LICENSE"));
  save(join(directory, "package.json"), { name: packageName("x64"), version: SEARCH_SOURCE.packageVersion, os: ["freebsd"], cpu: ["x64"], license: "MIT", files: ["bin/", "build-receipt.json", "LICENSE"] });
  const sha256 = hash(readFileSync(binary));
  save(join(directory, "build-receipt.json"), { source: SEARCH_SOURCE, inputs: SEARCH_BUILD_INPUTS, platform: "freebsd-x64", native: true, sha256, dependencies, compiler: "/usr/bin/cc", compilerVersion: run("/usr/bin/cc", ["--version"], { encoding: "utf8" }), rustc: run(join(toolchain, "bin/rustc"), ["-vV"], { encoding: "utf8" }), freebsdVersion: run("/bin/freebsd-version", ["-u"], { encoding: "utf8" }).trim(), libcSha256: hash(readFileSync("/lib/libc.so.7")), crt1Sha256: hash(readFileSync("/usr/lib/crt1.o")) });
  const expected = { platform: "freebsd-x64", sha256, receiptSha256: hash(readFileSync(join(directory, "build-receipt.json"))) };
  verifyFreebsdSearchPackage(directory, "x64", expected);
  save(join(work, "trusted-build-receipt.json"), expected);
  return { directory, expected };
}

if (import.meta.main) {
  const [inputs, work] = process.argv.slice(2);
  if (!work) throw new Error("usage: freebsd-search.mjs <authenticated-inputs> <new-task-work-directory>");
  console.log(JSON.stringify(buildFreebsdSearch(inputs, work), null, 2));
}
