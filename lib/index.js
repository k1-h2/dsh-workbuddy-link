import { createRequire } from "node:module";
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, ToolCallId, fileHandleText, isContextWindowExceededError, isQuotaExceededError, offloadedImageText, requestImageHandleText, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createSdkMcpServer } from "@qodercn-ai/qodercn-agent-sdk";
import { z } from "zod";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { TextDecoder } from "node:util";
import { isVolatile } from "@deepseek-ai/cosmokit";
import z$1 from "@deepseek-ai/schemastery";
//#region src/brand.ts
/** The CN edition, which the plugin was originally built for. */
const CN_BRAND = {
	id: "cn",
	family: "qoder",
	provider: "qoder-cn",
	defaultDisplayName: "Qoder CN",
	enabledKey: "cnEnabled",
	sdkPackage: "@qodercn-ai/qodercn-agent-sdk",
	cliPackages: [{
		scope: "@qodercn-ai",
		name: "qoderclicn"
	}],
	cliCommands: ["qoderclicn", "qodercn"],
	configDirName: ".qoder-cn",
	setupScript: "setup-qoderclicn.bat",
	staticCatalog: true
};
/**
* The international edition.
*
* The static CN catalog is deliberately NOT reused: model ids differ between
* the two plans, and a fallback the account cannot actually run would put
* unusable entries in the picker.
*/
const GLOBAL_BRAND = {
	id: "global",
	family: "qoder",
	provider: "qoder-intl",
	defaultDisplayName: "Qoder 国际版",
	enabledKey: "intlEnabled",
	sdkPackage: "@qoder-ai/qoder-agent-sdk",
	cliPackages: [{
		scope: "@qoder-ai",
		name: "qodercli"
	}],
	cliCommands: ["qodercli", "qoder"],
	configDirName: ".qoder",
	setupScript: "setup-qodercli.bat",
	staticCatalog: false
};
/**
* CodeBuddy, served through Tencent's Agent SDK.
*
* The SDK bundles its own CLI (`@tencent-ai/codebuddy-code`), so there is no
* global install step and no setup script: login is an SDK call whose region
* is chosen per request (`external` for the international site, `internal`
* for the mainland one). Enterprise/IOA/self-hosted login is out of scope.
*/
const CODEBUDDY_BRAND = {
	id: "codebuddy",
	family: "codebuddy",
	provider: "codebuddy",
	defaultDisplayName: "CodeBuddy",
	enabledKey: "codebuddyEnabled",
	sdkPackage: "@tencent-ai/agent-sdk",
	cliPackages: [{
		scope: "@tencent-ai",
		name: "codebuddy-code"
	}],
	cliCommands: ["codebuddy", "cbc"],
	configDirName: ".codebuddy",
	setupScript: null,
	staticCatalog: false
};
/**
* MiniMax Code, spoken over the Agent Client Protocol.
*
* `mcode acp` runs as a stdio ACP server. Unlike CodeBuddy, there is no SDK
* package to import: the plugin speaks the protocol directly and the CLI owns
* login, model selection and the upstream account. The login region is a
* config choice (`MAVIS_REGION` pins each process), not a brand.
*/
const MINIMAX_BRAND = {
	id: "minimax",
	family: "minimax",
	provider: "minimax-acp",
	defaultDisplayName: "MiniMax Code",
	enabledKey: "minimaxEnabled",
	sdkPackage: "@agentclientprotocol/sdk",
	cliPackages: [{
		scope: "@minimax-ai",
		name: "code"
	}],
	cliCommands: ["mcode"],
	configDirName: ".minimax",
	setupScript: null,
	staticCatalog: false
};
/** Every brand, in the order the settings pages list them. */
const BRANDS = [
	CN_BRAND,
	GLOBAL_BRAND,
	CODEBUDDY_BRAND,
	MINIMAX_BRAND
];
/** Whether a value names a Qoder edition. */
function isQoderBrand(value) {
	return value === "cn" || value === "global";
}
/** Whether a value names one of the provider brands. */
function isBrandId(value) {
	return isQoderBrand(value) || value === "codebuddy" || value === "minimax";
}
/** Whether a value names a CodeBuddy login region. */
function isCodeBuddyRegion(value) {
	return value === "global" || value === "cn";
}
/** The profile for one brand. */
function brandProfile(brand) {
	if (brand === "codebuddy") return CODEBUDDY_BRAND;
	if (brand === "minimax") return MINIMAX_BRAND;
	return brand === "global" ? GLOBAL_BRAND : CN_BRAND;
}
/**
* The region name the MiniMax CLI uses internally.
*
* The CLI calls the mainland site `cn` and the international one `en`; its
* login command accepts `global` and maps it to `en`. Processes are pinned
* with `MAVIS_REGION`, which also expects `cn`/`en`.
*/
function minimaxCliRegion(region) {
	return region === "cn" ? "cn" : "en";
}
/** The SDK environment a CodeBuddy region logs into. */
function codeBuddyEnvironment(region) {
	return region === "cn" ? "internal" : "external";
}
//#endregion
//#region src/catalog.ts
/** Default combined context capacity assumed for Qoder-backed models. */
const DEFAULT_CONTEXT_WINDOW = 2e5;
/** Default per-request output cap assumed for Qoder-backed models. */
const DEFAULT_MAX_TOKENS = 32e3;
/** Every model the account exposed at capture time, in SDK display order. */
const QODER_MODELS = [
	{
		id: "auto",
		name: "Auto",
		description: "Qoder 自动路由"
	},
	{
		id: "ultimate",
		name: "Ultimate",
		description: "最强档位路由"
	},
	{
		id: "performance",
		name: "Performance"
	},
	{
		id: "efficient",
		name: "Efficient"
	},
	{
		id: "lite",
		name: "Lite"
	},
	{
		id: "cmodel",
		name: "Cantus"
	},
	{
		id: "qmodel_38max",
		name: "Qwen3.8-Max"
	},
	{
		id: "qmodel_latest",
		name: "Qwen3.7-Max"
	},
	{
		id: "qmodel",
		name: "Qwen3.7-Plus"
	},
	{
		id: "kmodel_latest",
		name: "Kimi-K3"
	},
	{
		id: "kmodel",
		name: "Kimi-K2.7-Code"
	},
	{
		id: "gmodel",
		name: "GLM-5.3"
	},
	{
		id: "gm51model",
		name: "GLM-5.2"
	},
	{
		id: "dmodel",
		name: "DeepSeek-V4-Pro"
	},
	{
		id: "dfmodel",
		name: "DeepSeek-V4-Flash"
	},
	{
		id: "mmodel",
		name: "MiniMax-M3"
	}
];
/**
* Convenience aliases so a dsh deployment can keep using its own DeepSeek
* model names against the Qoder route.
*/
const MODEL_ALIASES = {
	"deepseek-v4-flash": "dfmodel",
	"deepseek-v4-pro": "dmodel"
};
/**
* Map a dsh-side model id onto a Qoder SDK model value.
*
* Aliases are checked first (config-supplied aliases take precedence over the
* built-in ones), then any `qoder-` prefix is stripped, and an empty result
* falls back to `auto`.
*
* @param model - model id from {@link import('@deepseek-ai/dsh-llm').GenerateOptions.model}.
* @param extraAliases - user-configured aliases, merged over {@link MODEL_ALIASES}.
* @returns the Qoder model value; the CLI falls back to `auto` for unknown values.
*/
function resolveQoderModelId(model, extraAliases) {
	const key = model.toLowerCase();
	const configured = extraAliases?.[key] ?? extraAliases?.[model];
	if (configured !== void 0 && configured.length > 0) return configured;
	const aliased = MODEL_ALIASES[key];
	if (aliased !== void 0) return aliased;
	const stripped = model.startsWith("qoder-") ? model.slice(6) : model;
	return stripped.length > 0 ? stripped : "auto";
}
//#endregion
//#region src/live.ts
/**
* Resolve one {@link Live} option, falling back when it is absent.
*
* @param value - the plain value or thunk, possibly undefined.
* @param fallback - value used when the option is absent or resolves to undefined.
* @returns the option's current value.
*/
function readLive(value, fallback) {
	const current = typeof value === "function" ? value() : value;
	return current === void 0 ? fallback : current;
}
/**
* Resolve one {@link Live} option that may legitimately be undefined.
*
* Separate from {@link readLive} because an option whose "unset" state is
* itself meaningful (`defaultReasoningEffort`: empty means "use the model's
* strongest level") has no fallback to apply.
*
* @param value - the plain value or thunk, possibly undefined.
* @returns the option's current value, or undefined when it is unset.
*/
function readLiveOptional(value) {
	return typeof value === "function" ? value() : value;
}
//#endregion
//#region src/cli.ts
/**
* Finding the local Qoder CLI of one edition, and the Node that has to run it.
*
* The SDK's default transport runs its worker runtime on a Node worker thread,
* which is a thread *inside* the DSH process. On Windows that puts the worker's
* bundled sharp (libvips 8.17) into the same address space as DSH's own sharp
* (libvips 8.18), and the loader satisfies the worker's `libvips-42.dll` import
* from the module already registered under that name. The ABI mismatch that
* follows fails every turn carrying an image, with libvips reporting
* `colourspace: parameter space not set` and the CLI answering
* `image_processing_failed`.
*
* A child process has its own address space, and is how an installed
* `qoderclicn` runs by itself anyway, so sessions hand the SDK an entry it can
* spawn. Naming that entry is all it takes: the SDK picks its process transport
* for any `pathToQoderCLIExecutable` that is not a worker-runtime module, which
* is exactly the transport that must not be used here.
*
* Nothing is invented. The CLI is looked for where the setup helper installs
* it and where the SDK bundles it; the Node to run it is the host's own, DSH's
* shipped runtime, or whatever `PATH` answers. When none of that is present the
* lookup returns nothing and the SDK keeps its default transport — worse for
* images, but not this module's place to fail a session over.
*
* @module dsh-agent-sdk-bridge/cli
*/
/**
* The switch that makes the CLI report its real token metering.
*
* The CLI prices every provider request, but before a usage record leaves the
* process it zeroes `input_tokens`, `output_tokens` and both cache buckets
* unless this switch is on — its own bundle guards the real values with
* `if (options?.exposeTokenCounts || tokenUsageRequested())`, and otherwise
* emits `{ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
* cache_read_input_tokens: 0 }` while keeping `credits` and the context ratio.
* That is why every counter the harness shows is an estimate here, and why
* `缓存命中` reads 0% no matter how much of a prompt the cache served.
*
* The names are the CLI's own env-catalog entries (`ENV_EXPOSE_TOKEN_USAGE`),
* brand-prefixed per build — the CN CLI reads `QODERCN_…`, the international
* one `QODER_…` — and both are set because which build answers is the lookup's
* decision, not this module's. The value is read as a boolean (`1`/`true`/`yes`).
*/
const EXPOSE_TOKEN_USAGE = {
	QODERCN_EXPOSE_TOKEN_USAGE: "1",
	QODER_EXPOSE_TOKEN_USAGE: "1"
};
/**
* A CLI the SDK can spawn, or nothing when this machine offers none.
*
* Candidates are tried in the order a user's own shell would resolve them:
* an explicit `QODERCLI_PATH` first, then the npm global roots, then the
* native builds the SDK and the CLI's own installer place. Each brand only
* ever sees its own package and state directory — handing the CN SDK the intl
* CLI (or the other way round) would speak one edition's protocol to the other
* edition's account. A worker-runtime module is skipped wherever it turns up,
* since the SDK answers such a path with the in-process worker this module
* exists to avoid.
*
* @param brand - which edition's CLI to look for.
* @param lookup - the machine to inspect; defaults to this process's.
*/
function resolveQoderCli(brand = "cn", lookup = {}) {
	const env = lookup.env ?? process.env;
	const platform = lookup.platform ?? process.platform;
	const exists = lookup.exists ?? existsSync;
	const suffix = platform === "win32" ? ".exe" : "";
	const node = resolveNode(lookup);
	for (const candidate of candidates(brand, env, suffix, node)) {
		if (!exists(candidate) || isWorkerRuntime(candidate)) continue;
		if (!isScript(candidate)) return { path: candidate };
		if (node !== void 0) return {
			path: candidate,
			nodeDir: path.dirname(node)
		};
	}
}
/**
* Query options that route a session through the CLI's own process.
*
* Empty when no CLI was found: the caller spreads this into its options, so an
* empty answer leaves the SDK's default transport in place.
*
* @param brand - which edition's CLI the session speaks to.
* @param lookup - the machine to inspect; defaults to this process's.
*/
function qoderCliOptions(brand = "cn", lookup = {}) {
	const cli = resolveQoderCli(brand, lookup);
	if (cli === void 0) return {};
	const env = cliChildEnv(brand);
	if (cli.nodeDir === void 0) return {
		pathToQoderCLIExecutable: cli.path,
		env
	};
	return {
		pathToQoderCLIExecutable: cli.path,
		executable: "node",
		env: {
			...env,
			PATH: `${cli.nodeDir}${path.delimiter}${env.PATH ?? ""}`
		}
	};
}
/**
* Whether a CLI path belongs to the other edition.
*
* `QODERCLI_PATH` predates the international edition and is set globally by
* some CN installs. Both SDKs read that one variable from the parent process
* before anything else, so an intl session would otherwise spawn the CN CLI and
* answer with the CN account. A path that names an edition is therefore never
* offered to the other one; a neutral custom build is still honoured for both.
*/
function isForeignCliPath(brand, candidate) {
	const text = candidate.replace(/\\/g, "/").toLowerCase();
	const chinese = text.includes("qoderclicn") || text.includes("@qodercn-ai") || text.includes("/.qoder-cn/");
	const global = !chinese && (text.includes("@qoder-ai") || text.includes("/.qoder/") || /(^|[/_-])qodercli(\.exe|\.js|$)/.test(text));
	return brand === "global" ? chinese : global;
}
/**
* Why this edition has no usable CLI, when `QODERCLI_PATH` explains it.
*
* `QODERCLI_PATH` predates the international edition and some installers
* export it machine-wide. Both SDKs read it from the parent process before any
* option this plugin can pass, so a value naming the *other* edition would
* hand this edition's session the other account. The lookup therefore never
* offers it ({@link isForeignCliPath}), and this reports the case where it is
* all the machine has, so the page can ask for the right CLI to be installed.
*
* This is a diagnosis, not a second rule: an edition that finds its own CLI is
* unaffected by the variable. That is what keeps one edition's install from
* blocking the other's sign-in — the earlier code treated any foreign value as
* fatal, so a machine that had only the intl CLI installed could not sign in
* to CN even after installing it if the lookup missed the new package.
*
* @param brand - the edition the caller is about to start.
* @param lookup - the machine to inspect; defaults to this process's.
* @returns the foreign override when this edition has nothing of its own.
*/
function foreignCliOverride(brand, lookup = {}) {
	const override = (lookup.env ?? process.env).QODERCLI_PATH;
	if (override === void 0 || override.length === 0) return void 0;
	if (!isForeignCliPath(brand, override)) return void 0;
	if (resolveQoderCli(brand, lookup) !== void 0) return void 0;
	return override;
}
/**
* The environment one session's child process receives.
*
* `QODERCLI_PATH` is stripped when it names the other edition: both SDKs read
* it from the parent before honouring any option, so leaving it in place would
* hand the intl session the CN CLI (and the CN account). Every other variable
* is inherited untouched — the CLI keeps its state in `PATH`-relative dirs.
*
* @param brand - which edition's child is being started.
* @param env - the environment to derive from; defaults to this process's.
*/
function cliChildEnv(brand, env = process.env) {
	const child = {
		...env,
		...EXPOSE_TOKEN_USAGE
	};
	const override = env.QODERCLI_PATH;
	if (override !== void 0 && override.length > 0 && isForeignCliPath(brand, override)) delete child.QODERCLI_PATH;
	return child;
}
/**
* The error text for {@link foreignCliOverride}.
*
* Deliberately says nothing about the variable or the path that caused it: the
* page's job here is to tell the user which CLI to install, not to explain the
* plugin's environment plumbing. The technical reason stays in the lookup.
*/
function cliConflictMessage(brand) {
	return `未检测到可用的 ${brandProfile(brand).cliCommands[0]}，请先安装并登录后再使用此版本。`;
}
/**
* Turn a CLI failure into something a user can act on.
*
* The SDK reports an outdated CLI as `Qoder CLI process exited with code 42`,
* which says nothing about the cause: CLI 1.1.81 removed the worker-session
* handshake the older SDK spoke, and its own log says so
* (`sdk_worker_removed: … Upgrade to the latest Qoder SDK version, or roll back
* the CLI`). The only fix available to a user is reinstalling the pair through
* the bundled helper, so say that instead of echoing the number.
*
* @param detail - the error text as the SDK reported it.
* @param brand - which edition's helper the message should name.
* @returns the original detail, prefixed with the actionable explanation.
*/
function cliFailureText(detail, brand) {
	if (/DaemonConfigurationConflict|Global daemon is already initialized with different options/i.test(detail)) return `本机 ${brandProfile(brand).cliCommands[0]} 的运行配置在本次会话期间发生了变化，SDK 的本地守护进程仍按旧配置运行。插件已重置这部分运行时，请重试一次；若仍失败，重启 DSH Web。原始信息：${detail}`;
	if (!/exit(?:ed)?(?: with)? code 42|sdk_worker_removed/i.test(detail)) return detail;
	const profile = brandProfile(brand);
	const pkg = profile.cliPackages[0];
	const spec = pkg === void 0 ? profile.cliCommands[0] : `${pkg.scope}/${pkg.name}`;
	const required = requiredCliVersion(brand);
	const target = required === void 0 ? spec : `${spec}@${required}`;
	return `本机 ${profile.cliCommands[0]} 与插件使用的 SDK 版本不匹配（CLI 已移除旧版握手，退出码 42）。请在设置页点「一键配置」重新安装配套版本，或手动执行 npm install -g ${target} 后重试。原始信息：${detail}`;
}
/**
* The CLI version the installed SDK expects, read from its runtime manifest.
*
* Each SDK release pins one CLI build: the two speak a wire protocol that
* changes between them, and a mismatch fails every session with a bare exit
* code. The bundled helper reads the same file, so the page and the helper
* agree on which build to install.
*
* @param brand - which edition's SDK to inspect.
* @returns the pinned version, or undefined when the manifest is unreadable.
*/
function requiredCliVersion(brand) {
	try {
		const dir = sdkDir(brandProfile(brand).sdkPackage);
		if (dir === void 0) return void 0;
		const manifest = JSON.parse(readFileSync(path.join(dir, "dist", "runtime-manifest.json"), "utf8"));
		return typeof manifest.qoderCliVersion === "string" && manifest.qoderCliVersion.length > 0 ? manifest.qoderCliVersion : void 0;
	} catch {
		return;
	}
}
/**
* The version of the installed CLI, read from its own package manifest.
*
* Read from disk rather than by running `--version`: a settings-page poll must
* not spawn a process every second, and the npm package always ships a
* manifest next to its entry. A native build without one answers undefined,
* which callers treat as "unknown" and never as a mismatch.
*
* @param brand - which edition's CLI to inspect.
* @returns the installed version, or undefined when it cannot be read.
*/
function installedCliVersion(brand) {
	const cli = resolveQoderCli(brand);
	if (cli === void 0) return void 0;
	for (const candidate of [path.join(path.dirname(cli.path), "package.json"), path.join(path.dirname(path.dirname(cli.path)), "package.json")]) try {
		const manifest = JSON.parse(readFileSync(candidate, "utf8"));
		if (typeof manifest.name !== "string" || !manifest.name.startsWith("@")) continue;
		if (typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
	} catch {}
}
/** Paths the CLI may live at, most explicit first. */
function candidates(brand, env, suffix, nodePath) {
	const profile = brandProfile(brand);
	const found = [];
	const push = (value) => {
		if (value !== void 0 && value.length > 0 && !found.includes(value)) found.push(value);
	};
	push(brand === "cn" ? env.QODERCN_CLI_PATH : env.QODER_CLI_PATH);
	if (env.QODERCLI_PATH !== void 0 && !isForeignCliPath(brand, env.QODERCLI_PATH)) push(env.QODERCLI_PATH);
	for (const root of nodeModulesRoots(env, nodePath)) for (const pkg of profile.cliPackages) {
		const dir = path.join(root, pkg.scope, pkg.name);
		for (const entry of packageEntries(dir, pkg.name, suffix)) push(entry);
	}
	const sdk = sdkDir(profile.sdkPackage);
	if (sdk !== void 0) for (const pkg of profile.cliPackages) push(path.join(sdk, "dist", "_bundled", `${pkg.name}${suffix}`));
	const home = env.QODER_CLI_HOME === void 0 || env.QODER_CLI_HOME.length === 0 ? homedir() : env.QODER_CLI_HOME;
	for (const pkg of profile.cliPackages) push(path.join(home, profile.configDirName, "local", `${pkg.name}${suffix}`));
	return found;
}
/**
* Every path one installed npm package can expose as its CLI.
*
* `main`/`bin` are read from the package's own manifest rather than guessed:
* the entry point has changed between CLI releases, and hard-coding only
* `bundle/<name>.js` reported an installed package as missing whenever it did
* not match. Unreadable manifests fall back to the conventional entries.
*/
function packageEntries(dir, name, suffix) {
	const entries = [
		path.join(dir, "bundle", `${name}.js`),
		path.join(dir, `${name}.js`),
		path.join(dir, "bundle", `${name}${suffix}`)
	];
	try {
		const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
		if (typeof manifest.main === "string") entries.push(path.join(dir, manifest.main));
		const bin = manifest.bin;
		if (typeof bin === "string") entries.push(path.join(dir, bin));
		else if (bin !== null && typeof bin === "object") {
			for (const value of Object.values(bin)) if (typeof value === "string") entries.push(path.join(dir, value));
		}
	} catch {}
	return entries;
}
/** `node_modules` roots a global install can land in. */
function nodeModulesRoots(env, nodePath) {
	const roots = [];
	const push = (value) => {
		if (value !== void 0 && value.length > 0 && !roots.includes(value)) roots.push(value);
	};
	push(env.NPM_CONFIG_PREFIX === void 0 ? void 0 : path.join(env.NPM_CONFIG_PREFIX, "node_modules"));
	push(env.APPDATA === void 0 ? void 0 : path.join(env.APPDATA, "npm", "node_modules"));
	push(path.join(homedir(), ".npm-global", "node_modules"));
	if (nodePath !== void 0) {
		const prefix = path.dirname(nodePath);
		push(path.join(prefix, "node_modules"));
		push(path.join(path.dirname(prefix), "lib", "node_modules"));
	}
	return roots;
}
/**
* The Node that runs a CLI script: this process when it *is* Node, else DSH's
* shipped runtime, else whatever `PATH` answers.
*
* DSH's runtime comes first among the fallbacks because it is the one Node a
* DSH install guarantees, whatever the user's PATH says — an Electron host
* launched from a desktop shortcut inherits an environment that need not carry
* Node at all.
*/
function resolveNode(lookup) {
	const env = lookup.env ?? process.env;
	const platform = lookup.platform ?? process.platform;
	const exists = lookup.exists ?? existsSync;
	const name = platform === "win32" ? "node.exe" : "node";
	const execPath = lookup.execPath ?? process.execPath;
	if (!(lookup.electron ?? process.versions.electron !== void 0) && path.basename(execPath).toLowerCase() === name) return execPath;
	const home = env.DSH_HOME === void 0 || env.DSH_HOME.length === 0 ? path.join(homedir(), ".dsh") : env.DSH_HOME;
	const runtimes = path.join(home, "dsh-runtimes");
	for (const runtime of listDir(runtimes, lookup)) {
		const candidate = path.join(runtimes, runtime, "dependencies", "node", "bin", name);
		if (exists(candidate)) return candidate;
	}
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (dir.length === 0) continue;
		const candidate = path.join(dir, name);
		if (exists(candidate)) return candidate;
	}
}
/**
* Directory of the installed SDK, for the native CLI build it may carry.
*
* The international package is optional, so a missing one answers undefined
* here rather than failing the lookup.
*/
function sdkDir(packageName) {
	try {
		const entry = createRequire(import.meta.url).resolve(packageName);
		const dir = path.dirname(entry);
		return path.basename(dir) === "dist" ? path.dirname(dir) : dir;
	} catch {
		return;
	}
}
/** Listing that answers nothing rather than throwing on a missing directory. */
function listDir(dir, lookup) {
	const read = lookup.readdir ?? ((target) => readdirSync(target));
	try {
		return read(dir);
	} catch {
		return [];
	}
}
/** Whether the SDK would run this entry through an interpreter. */
function isScript(entry) {
	return /\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(entry);
}
/**
* Whether the SDK would answer this entry with its in-process worker runtime,
* which is the transport this module exists to avoid. Kept in step with the
* SDK's own recognition rule so a path is never silently routed back in-process.
*/
function isWorkerRuntime(entry) {
	return /^(?:qoder(?:cli|clicn|cn)?-)?worker-runtime(?:\.obf)?\.mjs$/i.test(path.basename(entry));
}
//#endregion
//#region src/sdk.ts
/**
* The SDK package behind each brand.
*
* The Qoder editions publish the same API under different scopes, so the rest
* of the plugin imports this module instead of a package name. The CN SDK is a
* real dependency and is loaded eagerly; the international one is optional at
* runtime — a deployment that only has a CN account may not have it installed —
* so it is imported on demand and its absence is reported to the settings page
* as a plain error instead of failing the plugin's mount.
*
* CodeBuddy has its own, unrelated API and is loaded dynamically for the same
* reason: an account may never use it, and its package carries a large CLI.
*
* ## Why modules are reloaded
*
* Every Qoder SDK routes all queries through one **process-wide daemon** that
* is initialized with the first query's launch configuration (CLI path,
* interpreter, environment, proxy) and then refuses any different one for the
* life of the process:
*
*     DaemonConfigurationConflictError:
*       Global daemon is already initialized with different options
*
* The host is long-lived, so its configuration is not: a CLI can be
* reinstalled, an edition can appear, an installer can change the machine
* environment. When that happens the ready daemon no longer matches and every
* later query fails until the process restarts — a state the settings page
* cannot recover from on its own.
*
* So the module tracks the configuration signature it loaded under and takes a
* fresh instance whenever the signature changes; {@link resetSdk} does the same
* after a conflict is observed. A new instance has an empty daemon registry, so
* it initializes against the current configuration instead of arguing with the
* old one.
*
* @module dsh-agent-sdk-bridge/sdk
*/
const generations = /* @__PURE__ */ new Map();
/** Brands whose next load must take a fresh instance even if the signature matches. */
const forced = /* @__PURE__ */ new Set();
let counter = 0;
let codeBuddySdk;
const require = createRequire(import.meta.url);
/**
* The launch configuration a Qoder query would use, as a comparable string.
*
* Mirrors the fields the SDK's own daemon compares before reusing itself. The
* environment is included because the SDK hands it to the CLI verbatim, and a
* difference there is enough to make the daemon reject a query.
*
* @param brand - which edition's configuration to describe.
* @returns a stable string that changes exactly when the configuration does.
*/
function configurationSignature(brand) {
	const options = qoderCliOptions(brand);
	const env = Object.entries(options.env ?? {}).filter(([, value]) => value !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	return JSON.stringify({
		path: options.pathToQoderCLIExecutable ?? null,
		executable: options.executable ?? null,
		env
	});
}
/**
* Import one edition's SDK.
*
* A fresh instance is the same file imported under a unique URL: the module's
* top-level daemon state is per instance, while the implementation is shared by
* the module loader as usual.
*
* @param brand - which edition to load.
* @param fresh - ignore the already-loaded instance and take a new one.
*/
async function importSdk(brand, fresh) {
	const specifier = brandProfile(brand).sdkPackage;
	try {
		if (!fresh) return await import(
			/* @vite-ignore */
			specifier
);
		const entry = pathToFileURL(require.resolve(specifier)).href;
		counter += 1;
		return await import(
			/* @vite-ignore */
			`${entry}?generation=${counter}`
);
	} catch (error) {
		generations.delete(brand);
		forced.delete(brand);
		if (brand === "cn") throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`未安装国际版 SDK（${specifier}）：${detail}`);
	}
}
/**
* Load the SDK for one Qoder edition, under its current configuration.
*
* @param brand - which edition's SDK to load.
* @returns the SDK module.
*/
function loadSdk(brand) {
	const signature = configurationSignature(brand);
	const current = generations.get(brand);
	if (current !== void 0 && current.signature === signature && !forced.has(brand)) return current.module;
	const module = importSdk(brand, current !== void 0 || forced.delete(brand));
	const generation = {
		signature,
		module
	};
	generations.set(brand, generation);
	module.catch(() => {
		if (generations.get(brand) === generation) generations.delete(brand);
	});
	return module;
}
/**
* Drop the loaded instance so the next {@link loadSdk} starts a new daemon.
*
* @param brand - which edition to reset.
*/
function resetSdk(brand) {
	generations.delete(brand);
	forced.add(brand);
}
/**
* Whether an error is the SDK's daemon refusing a different configuration.
*
* @param error - whatever a query threw.
*/
function isDaemonConflict(error) {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.includes("DaemonConfigurationConflictError") || text.includes("Global daemon is already initialized with different options");
}
/**
* Run one idempotent SDK operation, recovering from a daemon conflict once.
*
* A conflict means the daemon was initialized under a configuration that no
* longer applies. A fresh module instance starts an empty daemon with the
* current one, so the retry succeeds without a restart. Only use this for
* operations that can be repeated without side effects (reads), never for a
* turn that may already have emitted output.
*
* @param brand - which edition to query.
* @param run - the operation, given the module to use.
*/
async function withSdk(brand, run) {
	try {
		return await run(await loadSdk(brand));
	} catch (error) {
		if (!isDaemonConflict(error)) throw error;
		resetSdk(brand);
		return await run(await loadSdk(brand));
	}
}
/**
* Open one cheap control query so a stale daemon is discovered before a turn
* starts streaming.
*
* A turn cannot be retried once it has emitted output, so the session path has
* to find out about a configuration conflict first. `getUsageInfo` is a
* control request: it initializes the daemon and reads the account without
* running a model turn.
*
* @param brand - which edition to probe.
*/
async function probeDaemon(brand) {
	const sdk = await loadSdk(brand);
	const q = sdk.query({
		prompt: (async function* () {
			await new Promise(() => {});
		})(),
		options: {
			...qoderCliOptions(brand),
			auth: sdk.qodercliAuth(),
			tools: [],
			allowedTools: [],
			settingSources: [],
			maxTurns: 1
		}
	});
	try {
		await q.getUsageInfo();
	} finally {
		await q.close().catch(() => void 0);
	}
}
/**
* Load the CodeBuddy Agent SDK.
*
* Kept lazy because the package ships its own ~200 MB CLI and is useless to a
* deployment that never enables CodeBuddy.
*/
function loadCodeBuddySdk() {
	codeBuddySdk ??= importCodeBuddySdk();
	return codeBuddySdk;
}
async function importCodeBuddySdk() {
	const specifier = brandProfile("codebuddy").sdkPackage;
	try {
		return await import(
			/* @vite-ignore */
			specifier
);
	} catch (error) {
		codeBuddySdk = void 0;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`CodeBuddy SDK 不可用（${specifier}）：${detail}`);
	}
}
//#endregion
//#region src/models.ts
/** How long a fetched catalog stays fresh by default. */
const DEFAULT_MODEL_CACHE_TTL_MS = 3e5;
/** Give up on one CLI catalog fetch after this long by default. */
const DEFAULT_FETCH_TIMEOUT_MS = 2e4;
/**
* Last successful catalog per brand, shared by every {@link QoderModelCatalog}
* in this process.
*
* A settings write does NOT restart this plugin — a volatile edit is committed
* into the running cells (see `live.ts`) — so the cache now only has to survive
* a real remount: enabling the plugin, a profile reload, or a DSH restart. It
* matters in exactly those cases, because the first settings read after the
* remount would otherwise cold-start the Qoder CLI and stall the page for
* seconds.
*
* The entry carries its own timestamp and is only used while it is still within
* the requesting catalog's TTL, so normal freshness is unchanged.
*/
const sharedSnapshots = /* @__PURE__ */ new Map();
/** Cached live CLI catalog with a static fallback. */
var QoderModelCatalog = class {
	brand;
	ttlMs;
	fetchTimeoutMs;
	cached;
	inflight;
	/** Why the last refresh failed, for the settings page's guidance. */
	failure;
	/**
	* @param brand - which edition's CLI answers.
	* @param ttlMs - how long a fetched catalog stays fresh before a re-fetch.
	*   Read per use, so a settings edit takes effect on the next read.
	* @param fetchTimeoutMs - how long one CLI catalog fetch may take before the
	*   static fallback takes over.
	*/
	constructor(brand, ttlMs, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
		this.brand = brand;
		this.ttlMs = ttlMs;
		this.fetchTimeoutMs = fetchTimeoutMs;
	}
	/**
	* Raw live entries; the stale snapshot when a refresh fails, else nothing.
	*
	* Filtered to the subscription's official models here, so the picker and the
	* settings page cannot disagree about what the account has.
	*/
	async liveModels() {
		const ttlMs = readLive(this.ttlMs, DEFAULT_MODEL_CACHE_TTL_MS);
		const fresh = (snapshot) => snapshot !== void 0 && Date.now() - snapshot.at < ttlMs;
		const cached = this.cached ?? sharedSnapshots.get(this.brand);
		if (fresh(cached) && cached !== void 0) {
			this.cached = cached;
			return officialOnly(cached.models);
		}
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = void 0;
		});
		try {
			const models = await this.inflight;
			const snapshot = {
				at: Date.now(),
				models
			};
			this.cached = snapshot;
			sharedSnapshots.set(this.brand, snapshot);
			this.failure = void 0;
			return officialOnly(models);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.failure = cliFailureText(detail, this.brand);
			return officialOnly((this.cached ?? sharedSnapshots.get(this.brand))?.models ?? []);
		}
	}
	/**
	* The last successful live list, without fetching.
	*
	* The model picker resolves a route on every switch, and a switch must not
	* wait on a CLI cold start (up to the fetch timeout). Callers that need an
	* immediate answer read this and let {@link liveModels} refresh behind them;
	* `undefined` means nothing has been read yet, which only the first switch
	* has to wait for.
	*/
	snapshot() {
		const cached = this.cached ?? sharedSnapshots.get(this.brand);
		return cached === void 0 ? void 0 : officialOnly(cached.models);
	}
	/** Why the last refresh failed, or undefined when it succeeded. */
	get error() {
		return this.failure;
	}
	/**
	* Drop the cached catalog so the next read goes back to the CLI.
	*
	* What the CLI answers depends on state this plugin does not own — whether it
	* is installed at all, and which account is signed in — and an empty answer is
	* cached like any other. So after the setup helper has run, the page's next
	* read must not be served from a snapshot taken before that login existed.
	*/
	invalidate() {
		this.cached = void 0;
		sharedSnapshots.delete(this.brand);
		this.failure = void 0;
	}
	/** dsh catalog entries: the enabled live list, or the static fallback. */
	async models() {
		const live = (await this.liveModels()).filter((model) => model.isEnabled !== false);
		if (live.length === 0) return brandProfile(this.brand).staticCatalog ? QODER_MODELS : [];
		return live.map((model) => ({
			id: model.value,
			name: model.displayName.length > 0 ? model.displayName : model.value,
			...model.description.length > 0 ? { description: model.description } : {},
			...model.isVl === true ? { isVl: true } : {}
		}));
	}
	async fetch() {
		if (foreignCliOverride(this.brand) !== void 0) throw new Error(cliConflictMessage(this.brand));
		if (resolveQoderCli(this.brand) === void 0) throw new Error(cliConflictMessage(this.brand));
		return withSdk(this.brand, (sdk) => this.read(sdk));
	}
	async read(sdk) {
		const q = sdk.query({
			prompt: inertInput$2(),
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				settingSources: [],
				maxTurns: 1
			}
		});
		try {
			const timeout = readLive(this.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS);
			const uid = (await withTimeout$2(q.accountInfo(), timeout).catch(() => void 0))?.userId;
			const models = await withTimeout$2(q.getAvailableModels(uid === void 0 ? {} : { uid }), timeout);
			if (models.length > 0) return models;
			for (const strategy of ["cache", "live"]) {
				const fallback = await withTimeout$2(q.getAvailableModels({
					...uid === void 0 ? {} : { uid },
					fetchStrategy: strategy
				}), timeout).catch(() => []);
				if (fallback.length > 0) return fallback;
			}
			return [];
		} finally {
			await q.close().catch(() => void 0);
		}
	}
};
/**
* Keep only the subscription's official models.
*
* The CLI also returns models the account added itself (`source` is `user` or
* `custom`): bring-your-own-key routes, which upstream serves on a separate
* provider. DSH runs on the subscription catalog and has no use for those, so
* they are dropped at this single layer — the picker, the settings page and
* the request path all read from here and cannot diverge.
*
* @param models - entries as the CLI reported them.
* @returns the same list without account-added entries.
*/
function officialOnly(models) {
	return models.filter((model) => model.source !== "user" && model.source !== "custom");
}
/**
* The credit multiplier upstream quotes for one model.
*
* Present on every live entry as `priceFactor`; `0` means the model is free.
* Returned as a number rather than a formatted string so callers decide how to
* render it.
*
* @param entry - one live catalog entry.
* @returns the multiplier, or undefined when upstream did not quote one.
*/
function priceFactorOf(entry) {
	const value = entry.priceFactor;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/** Streaming prompt that never yields, so no model turn runs during the fetch. */
async function* inertInput$2() {
	await new Promise(() => {});
}
function withTimeout$2(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`qoder request timed out after ${ms}ms`));
		}, ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
//#endregion
//#region src/model-cache.ts
/**
* Cache-first catalogue reads for the model picker.
*
* The harness resolves a route every time the user switches model or reasoning
* level, and each of the three providers answers that resolution from a
* catalogue whose fetch is expensive: Qoder cold-starts its CLI (up to the
* fetch timeout), CodeBuddy boots a process, MiniMax probes over ACP. Awaiting
* that fetch inside a resolution made the picker freeze for seconds whenever
* the cache had just expired.
*
* So a resolution reads the last successful snapshot when there is one and lets
* the catalogue refresh behind it; only the very first resolution, where there
* is nothing to show, waits. A snapshot that is merely stale still describes
* the same account's models, so answering from it is no less correct than the
* previous behaviour of answering from a failed fetch's fallback.
*
* @module dsh-agent-sdk-bridge/model-cache
*/
/**
* The cached list when one exists, otherwise the awaited fetch.
*
* @param snapshot - last successful catalogue, or undefined before the first.
* @param fetch - the catalogue's normal (TTL-aware, in-flight-sharing) read.
* @returns the entries to resolve against, never empty-by-surprise when a
*   snapshot exists.
*/
async function cachedModels(snapshot, fetch) {
	if (snapshot !== void 0 && snapshot.length > 0) {
		fetch().catch(() => void 0);
		return snapshot;
	}
	return fetch();
}
//#endregion
//#region src/tokens.ts
/**
* Script-aware text pricing, shared by the input and output estimators.
*
* The harness prices text at a flat 4 chars/token (dsh-token-meter's
* `CHARS_PER_TOKEN`). That is close for Latin text but under-prices Chinese by
* about 2.3x, which matters twice over in this plugin: it reports the tokens for
* a turn, and the harness derives `tok/s` from the output half of that report.
* A flat rate therefore made Chinese replies look roughly half as fast as they
* really are.
*
* The rates below were measured against this backend's own tokenizer, by
* least-squares fit over four content sizes per script, each read against the
* CLI's `context_usage_ratio` with a window the CLI had confirmed it honoured:
*
* | script | chars/token | tokens/char |
* |--------|-------------|-------------|
* | CJK    | 1.77        | 0.565       |
* | ASCII  | 5.20        | 0.192       |
*
* A constant offset in that fit (qodercli's own prompt, skills and tool
* definitions, ~127 tokens) is deliberately not modelled here: it belongs to the
* CLI's session, not to the text being priced.
* @module dsh-agent-sdk-bridge/tokens
*/
/** Characters per token for wide (CJK) text, measured. */
const WIDE_CHARS_PER_TOKEN = 1.77;
/** Characters per token for narrow (Latin, digits, punctuation) text, measured. */
const NARROW_CHARS_PER_TOKEN = 5.2;
/**
* Whether this tokenizer prices a character as wide (CJK) text.
*
* Ranges follow the Unicode blocks that CJK tokenizers treat as one-or-more
* tokens per character, including the fullwidth forms that Chinese punctuation
* uses. Everything else is priced as narrow text.
*/
function isWideChar(character) {
	const code = character.codePointAt(0) ?? 0;
	return code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12353 && code <= 13311 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 40960 && code <= 42191 || code >= 44032 && code <= 55203 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65135 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 262141;
}
/** How many of a text's characters are wide (CJK) text. */
function countWideChars(text) {
	let wide = 0;
	for (const character of text) if (isWideChar(character)) wide += 1;
	return wide;
}
/**
* Price text by its script mix, rather than at a flat 4 chars/token.
*
* @param chars - total character count.
* @param wideChars - how many of those characters are wide (CJK) text.
* @returns the estimated token count.
*/
function estimateTextTokens(chars, wideChars) {
	const wide = Math.max(0, Math.min(chars, wideChars));
	return wide / WIDE_CHARS_PER_TOKEN + (chars - wide) / NARROW_CHARS_PER_TOKEN;
}
/**
* The output tokens one turn generated, priced by script.
*
* Everything the model produced belongs here, whatever block carried it: visible
* text, reasoning, and tool-call names and arguments. That last one is easy to
* miss and usually the largest — measured at 86% of the characters in a
* three-call turn — and because the harness derives `tok/s` from the output
* tokens an adapter reports, omitting it under-reports speed several fold on
* exactly the multi-step agentic work where the figure is worth reading.
*
* Reasoning is a SUBSET of the output total, not a separate bucket: the harness
* discards an entire reading whose `reasoningTokens` exceeds its `outputTokens`,
* so {@link usage} clamps it rather than trusting the caller to.
*/
var TurnOutputAccounting = class {
	chars = 0;
	wideChars = 0;
	reasoningChars = 0;
	reasoningWideChars = 0;
	/** Count generated text: visible output, or a tool-call name or arguments. */
	addOutput(text) {
		if (text.length === 0) return;
		this.chars += text.length;
		this.wideChars += countWideChars(text);
	}
	/** Count generated reasoning, which is also part of the output total. */
	addReasoning(text) {
		if (text.length === 0) return;
		this.addOutput(text);
		this.reasoningChars += text.length;
		this.reasoningWideChars += countWideChars(text);
	}
	/** Total generated characters, for diagnostics. */
	get outputChars() {
		return this.chars;
	}
	/** Generated reasoning characters, a subset of {@link outputChars}. */
	get reasoningCharsTotal() {
		return this.reasoningChars;
	}
	/** Discard the turn's counts; called when a turn ends or is retried. */
	reset() {
		this.chars = 0;
		this.wideChars = 0;
		this.reasoningChars = 0;
		this.reasoningWideChars = 0;
	}
	/**
	* The turn's `outputTokens` and, when it reasoned, its `reasoningTokens`.
	*
	* Both are at least 1 so a turn that produced only a tool call still reports a
	* positive count, and reasoning never exceeds output.
	*/
	usage() {
		const outputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.chars, this.wideChars)));
		if (this.reasoningChars === 0) return { outputTokens };
		const reasoningTokens = Math.max(1, Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars)));
		return {
			outputTokens,
			reasoningTokens: Math.min(reasoningTokens, outputTokens)
		};
	}
	/**
	* This turn's reasoning tokens, clamped inside a real metered output total.
	*
	* Used when the CLI reports genuine `output_tokens`: the reasoning figure is
	* still the local estimate, but it must stay a subset of what the provider
	* counted or the harness discards the reading.
	*
	* @param meteredOutput - the provider's own output token count.
	* @returns a spreadable `reasoningTokens` field, or nothing when unmeasured.
	*/
	reasoningTokensWithin(meteredOutput) {
		if (this.reasoningChars === 0) return {};
		const reasoningTokens = Math.ceil(estimateTextTokens(this.reasoningChars, this.reasoningWideChars));
		return { reasoningTokens: Math.max(0, Math.min(meteredOutput, reasoningTokens)) };
	}
};
//#endregion
//#region src/render.ts
/**
* Render harness messages into the turns fed to the inner Qoder session.
* Tool calls and results need no protocol here — they travel through the
* in-process MCP server — so this layer handles conversational context: the
* host system prompt, user turns, and (for full rebuilds) prior history as
* compact text.
*
* A feed is plain text unless the *current* turn carries image occurrences,
* in which case it is a part list so those bytes can ride along. Historical
* images stay text: the harness has already replaced them with its own
* placeholder for text-only routes, and re-sending archived pixels on every
* rebuild would price a screenshot into every later request.
* @module dsh-llm-qoder/render
*/
/**
* Model-facing handle for one image.
*
* The host's native adapters use the same text: it names the attachment, its
* pixel size and media type, and the read-only normalized copy on disk, and it
* tells the model to copy that file to a writable path before editing. Pixels
* alone let a model describe an image but not process it — without this path
* the model goes looking through the workspace for a file that was never there.
*/
function imageRefText(ref, path) {
	if (path === void 0) return `[图片附件 ${String(ref.attachmentId)}（${ref.width}×${ref.height}px，${ref.mediaType}）]`;
	return requestImageHandleText(ref, {
		width: ref.width,
		height: ref.height
	}, { readonlyPath: path });
}
/**
* Image references in block order, skipping occurrences the surface already
* offloaded: an offload is a durable fact the harness renders as path-bearing
* placeholder text on every route, so re-sending those pixels would undo it.
*/
function imageRefs(blocks) {
	const refs = [];
	for (const block of blocks) if (block.type === "image" && block.offloaded !== true) refs.push(block.attachment);
	return refs;
}
/** Render one content-block list as plain text; non-text blocks get handles. */
function renderBlocks(blocks, imagePath) {
	const parts = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			parts.push(block.text);
			break;
		case "reasoning": break;
		case "image":
			parts.push(block.offloaded === true ? offloadedImageText(block.attachment) : imageRefText(block.attachment, imagePath?.(block.attachment)));
			break;
		case "file":
			parts.push(fileHandleText(block.attachment, void 0));
			break;
		case "tool-call":
			parts.push(`[调用了工具 ${block.name}(${block.arguments})]`);
			break;
		case "tool-addition":
			parts.push(`[工具启用 ${block.toolName}]`);
			break;
		case "tool-removal":
			parts.push(`[工具停用 ${block.toolName}]`);
			break;
		default: parts.push(JSON.stringify(block));
	}
	return parts.join("\n");
}
/** Role tag {@link renderMessage} uses, without the rendered content. */
function roleTag(message) {
	switch (message.role) {
		case "system": return "系统提示";
		case "developer": return "开发者";
		case "user": return "用户";
		case "assistant": return "助手";
		case "tool": return "工具结果";
	}
}
/**
* Render one request message with its role tag. A request-only user input has
* no durable identity or source, so it reads exactly like a user message.
*/
function renderMessage(message, imagePath) {
	return `[${roleTag(message)}] ${renderBlocks(message.content, imagePath)}`;
}
/** Preamble establishing the inner model's role as this agent's LLM backend. */
const BACKEND_ROLE = [
	"你在为一个编码 agent（宿主）充当 LLM API 后端：宿主把它的对话喂给你，你只输出\"下一条助手回复\"本身。",
	"宿主的工具已经通过 MCP 挂进来，需要用工具时直接调用，不要描述你会在别的环境里怎么调。",
	"不要复述对话，不要解释你的角色。"
].join("\n");
/**
* Join feed sections into one feed. While no section carries an image the
* result is the historical text shape, sections separated by a blank line;
* the first image turns the whole feed into parts, with the text around it
* merged into the parts before and after.
*/
function joinFeeds(sections) {
	const parts = [];
	const push = (part) => {
		if (part.type === "text" && part.text.length === 0) return;
		const previous = parts.at(-1);
		if (previous !== void 0 && previous.type === "text" && part.type === "text") {
			previous.text = `${previous.text}\n\n${part.text}`;
			return;
		}
		parts.push(part.type === "text" ? {
			type: "text",
			text: part.text
		} : {
			type: "image",
			attachment: part.attachment
		});
	};
	for (const section of sections) if (typeof section === "string") push({
		type: "text",
		text: section
	});
	else for (const part of section) push(part);
	if (parts.filter((part) => part.type === "image").length > 0) return parts;
	return parts.map((part) => part.type === "text" ? part.text : "").join("\n\n");
}
/** Render a block list as parts, keeping image occurrences as their references. */
function blockParts(blocks) {
	const parts = [];
	let pending = [];
	const flush = () => {
		if (pending.length === 0) return;
		parts.push({
			type: "text",
			text: pending.join("\n")
		});
		pending = [];
	};
	for (const block of blocks) {
		if (block.type === "image" && block.offloaded !== true) {
			flush();
			parts.push({
				type: "image",
				attachment: block.attachment
			});
			continue;
		}
		const text = renderBlocks([block]);
		if (text.length > 0) pending.push(text);
	}
	flush();
	return parts;
}
/** Prefix a label onto a feed, folding it into the leading text when there is any. */
function label(labelText, feed) {
	if (typeof feed === "string") return labelText + feed;
	const first = feed[0];
	if (first === void 0) return [{
		type: "text",
		text: labelText
	}];
	if (first.type === "text") return [{
		type: "text",
		text: `${labelText}${first.text}`
	}, ...feed.slice(1)];
	return [{
		type: "text",
		text: labelText
	}, ...feed];
}
/**
* Index where the message list's current turn starts: everything after the
* last assistant reply is new content the inner session has not seen, so its
* images are worth forwarding as bytes.
*/
function currentTurnStart(messages) {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i + 1;
	return 0;
}
/** Image references carried by a feed, in order. */
function feedImageRefs(feed) {
	if (typeof feed === "string") return [];
	return feed.filter((part) => part.type === "image").map((part) => part.attachment);
}
/** Flatten a feed back to text, replacing images with the harness handle text. */
function feedToText(feed, imagePath) {
	if (typeof feed === "string") return feed;
	return feed.map((part) => {
		if (part.type === "text") return part.text;
		const path = imagePath?.(part.attachment);
		return path === void 0 ? textOnlyImageText(part.attachment) : imageRefText(part.attachment, path);
	}).filter((text) => text.length > 0).join("\n\n");
}
/**
* Split a feed into text and resolved images for providers with a vision API.
*
* The two non-Qoder adapters (CodeBuddy, MiniMax) speak their own content-block
* shapes, so this returns a neutral list rather than a provider shape: text
* parts pass through, an image uses its bytes when the host could read them,
* and an unreadable image keeps a note naming what was dropped instead of
* silently disappearing from the prompt.
*/
function resolvedFeedParts(feed, images) {
	const parts = [];
	if (typeof feed === "string") {
		if (feed.length > 0) parts.push({
			type: "text",
			text: feed
		});
		return parts;
	}
	for (const part of feed) {
		if (part.type === "text") {
			if (part.text.length > 0) parts.push({
				type: "text",
				text: part.text
			});
			continue;
		}
		const resolved = images.get(String(part.attachment.attachmentId));
		parts.push(resolved === void 0 ? {
			type: "image-unreadable",
			attachment: part.attachment
		} : {
			type: "image",
			attachment: part.attachment,
			data: resolved.data,
			mediaType: resolved.mediaType
		});
	}
	return parts;
}
/** Literal characters in a feed; images contribute their pixels, not text. */
function feedTextLength(feed) {
	if (typeof feed === "string") return feed.length;
	return feed.reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0);
}
/**
* How many of a feed's literal characters are wide (CJK) text.
*
* The token estimate prices wide and narrow text at different rates, so a bare
* character count is not enough to price a feed that mixes Chinese and code.
*/
function feedWideCharCount(feed) {
	if (typeof feed === "string") return countWideChars(feed);
	return feed.reduce((total, part) => total + (part.type === "text" ? countWideChars(part.text) : 0), 0);
}
/**
* Compose the first feed for a fresh session: backend role, the host system
* prompt, and the existing conversation as compact context. Messages of the
* current turn keep their image references; earlier ones are handles.
*/
function renderInitialFeed(system, messages, imagePath) {
	const from = currentTurnStart(messages);
	const history = [];
	for (const [index, message] of messages.entries()) {
		const entry = index >= from && imageRefs(message.content).length > 0 ? label(`[${roleTag(message)}] `, blockParts(message.content)) : renderMessage(message, imagePath);
		if (feedToText(entry, imagePath).length > 0) history.push(entry);
	}
	const sections = [BACKEND_ROLE];
	if (system !== void 0 && system.length > 0) sections.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`);
	const first = history[0];
	if (first !== void 0) {
		sections.push(label("---- 宿主对话记录 ----\n", first));
		sections.push(...history.slice(1));
	}
	sections.push("---- 以上是背景。输出下一条助手回复。 ----");
	return joinFeeds(sections);
}
/** Render a brand-new host user turn; images stay references, text-only stays a string. */
function renderUserTurn(blocks) {
	if (imageRefs(blocks).length === 0) return `[用户] ${renderBlocks(blocks)}`;
	return label("[用户] ", blockParts(blocks));
}
/** Render an in-place-updated message (runtime-context snapshots and the like). */
function renderRefreshed(message) {
	return `${renderMessage(message)}\n（宿主原位刷新了这条消息）`;
}
//#endregion
//#region src/jsonschema.ts
/**
* Convert dsh `ToolSchema.parameters` (a JSON Schema object) into a zod raw
* shape for the SDK's in-process MCP `tool()` registration. Fidelity is
* one-directional on purpose: anything the converter does not recognize maps
* to `z.unknown()`, and objects stay loose (zod strips unknown keys instead
* of rejecting them), so a converted tool never rejects arguments the host
* tool would have accepted. Unmapped PROPERTY NAMES still appear in the shape
* (as `z.unknown()`), so nothing the model sends is silently stripped.
* @module dsh-llm-qoder/jsonschema
*/
/**
* Convert one JSON Schema node into one zod schema.
* @param schema - a JSON Schema node (object form expected).
* @param depth - recursion guard; past the cap every node becomes `z.unknown()`.
* @returns a zod schema covering the recognized constructs.
*/
function jsonSchemaToZod(schema, depth = 0) {
	if (schema === void 0 || depth > 6) return z.unknown();
	if (Array.isArray(schema.enum)) {
		const values = schema.enum.filter((v) => typeof v === "string");
		if (values.length === schema.enum.length && values.length > 0) return z.enum(values);
		return z.unknown();
	}
	const type = schema.type;
	const description = typeof schema.description === "string" ? schema.description : void 0;
	let base;
	switch (type) {
		case "string":
			base = z.string();
			break;
		case "number":
			base = z.number();
			break;
		case "integer":
			base = z.number().int();
			break;
		case "boolean":
			base = z.boolean();
			break;
		case "array": {
			const items = schema.items;
			base = z.array(jsonSchemaToZod(typeof items === "object" && items !== null && !Array.isArray(items) ? items : void 0, depth + 1));
			break;
		}
		case "object": {
			const properties = schema.properties;
			const required = Array.isArray(schema.required) ? schema.required.filter((v) => typeof v === "string") : [];
			const shape = {};
			if (typeof properties === "object" && properties !== null) for (const [key, node] of Object.entries(properties)) {
				const nodeSchema = typeof node === "object" && node !== null && !Array.isArray(node) ? node : void 0;
				shape[key] = required.includes(key) ? jsonSchemaToZod(nodeSchema, depth + 1) : jsonSchemaToZod(nodeSchema, depth + 1).optional();
			}
			base = z.object(shape);
			break;
		}
		default: base = z.unknown();
	}
	return description === void 0 ? base : base.describe(description);
}
/**
* Convert a tool's `parameters` JSON Schema into a zod raw shape for `tool()`.
* A non-object schema yields a single catch-all shape so registration stays valid.
* @param parameters - the JSON Schema object from a dsh `ToolSchema`.
* @returns the zod raw shape handed to the SDK MCP `tool()`.
*/
function jsonSchemaToShape(parameters) {
	const properties = parameters.properties;
	if (typeof properties !== "object" || properties === null) return {};
	const shape = {};
	const required = Array.isArray(parameters.required) ? parameters.required.filter((v) => typeof v === "string") : [];
	for (const [key, node] of Object.entries(properties)) {
		const nodeSchema = typeof node === "object" && node !== null && !Array.isArray(node) ? node : void 0;
		shape[key] = required.includes(key) ? jsonSchemaToZod(nodeSchema, 1) : jsonSchemaToZod(nodeSchema, 1).optional();
	}
	return shape;
}
//#endregion
//#region src/session.ts
/**
* One long-lived inner Qoder CLI session per host session id: a channel-fed
* `query()` subprocess whose model continuation streams out as harness
* `StreamChunk`s. Host tool calls travel through an in-process MCP server:
* the handler parks on a promise, the adapter finishes the turn with
* `tool-calls`, and the next host request (carrying tool results) resolves
* the parked promise so the inner model continues with the result in place.
* @module dsh-llm-qoder/session
*/
/** MCP server name this adapter exposes host tools under. */
const MCP_SERVER_NAME = "dsh-host";
/** Prefix qodercli uses for this server's tools inside `canUseTool`. */
const MCP_TOOL_PREFIX$1 = `mcp__${MCP_SERVER_NAME}__`;
/**
* How long a handler the CLI never announced waits for a result before failing.
*
* Paired handlers are settled by the host request that follows them, not by
* this deadline: a host tool may legitimately run far longer than two minutes,
* and a wall clock cannot tell a slow tool from a lost call.
*/
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 12e4;
/** How long the inner process gets to acknowledge an abort before the turn is force-ended. */
const DEFAULT_ABORT_GRACE_MS = 5e3;
/** Inner turns allowed for one side-channel (title, compaction) request. */
const DEFAULT_COLD_MAX_TURNS = 4;
/** Minimal push-only async channel feeding the SDK's streaming-input mode. */
function createChannel() {
	const queue = [];
	let resolve = null;
	return {
		push(message) {
			if (resolve !== null) {
				const settle = resolve;
				resolve = null;
				settle({
					value: message,
					done: false
				});
			} else queue.push(message);
		},
		[Symbol.asyncIterator]() {
			return { next() {
				const message = queue.shift();
				if (message !== void 0) return Promise.resolve({
					value: message,
					done: false
				});
				return new Promise((settle) => {
					resolve = settle;
				});
			} };
		}
	};
}
/** Unbounded FIFO the consumer pushes into and the active turn pumps out. */
var TurnQueue = class {
	items = [];
	resolve = null;
	closed = false;
	push(item) {
		if (this.closed) return;
		if (this.resolve !== null) {
			const settle = this.resolve;
			this.resolve = null;
			settle({
				value: item,
				done: false
			});
		} else this.items.push(item);
	}
	close() {
		this.closed = true;
		if (this.resolve !== null) {
			const settle = this.resolve;
			this.resolve = null;
			settle({
				value: void 0,
				done: true
			});
		}
	}
	[Symbol.asyncIterator]() {
		return { next: () => {
			const item = this.items.shift();
			if (item !== void 0) return Promise.resolve({
				value: item,
				done: false
			});
			if (this.closed) return Promise.resolve({
				value: void 0,
				done: true
			});
			return new Promise((settle) => {
				this.resolve = settle;
			});
		} };
	}
	/** Whether the turn already ended; late pushes are dropped. */
	get isClosed() {
		return this.closed;
	}
};
/**
* Whether a usage record carries real metering rather than the CLI's zero filler.
*
* The CLI attaches a usage record to several frames and leaves the four token
* counters at zero on all but one kind; a real request always consumed a prompt
* and produced output, so at least one counter being positive is the whole test.
*/
function carriesTokens(usage) {
	const positive = (value) => typeof value === "number" && value > 0;
	return positive(usage.input_tokens) || positive(usage.output_tokens) || positive(usage.cache_read_input_tokens) || positive(usage.cache_creation_input_tokens);
}
/**
* The occupancy sample one arriving frame may contribute, if any.
*
* Exactly one carrier may: the `message_delta` emitted when a provider request
* finishes, whose usage describes that request's prompt — which is precisely
* what context occupancy means. The other carriers are traps, confirmed against
* a live CLI with a tool the inner model calls four times in one turn:
*
*  - `message_start`, and the assembled `assistant` message, report all four
*    counters as zero; a request's numbers exist only once it finishes.
*  - the `result` frame reports the WHOLE inner turn's total, summed over every
*    provider request that turn made. One host step is one request, but an inner
*    turn ends only when the model stops calling tools, so a long agentic run
*    reports a multiple of any real prompt — that four-request turn ended at
*    `input_tokens` 2 921 where each request had used 608–837. Taking that total
*    as the session's occupancy pegged the harness context meter at 100%
*    (9.8M against a 1M window) and latched it there.
*
* @param message - one arriving SDK message.
* @returns the usage to sample, or undefined when this frame may not supply one.
*/
function requestUsageSample(message) {
	if (message.type !== "stream_event") return void 0;
	const usage = message.event?.usage ?? message.event?.message?.usage;
	return usage !== void 0 && carriesTokens(usage) ? usage : void 0;
}
/**
* One frame's own metering, translated into the harness's token buckets.
*
* Three rules, each measured against a live CLI rather than inferred:
*
* 1. `input_tokens` IS the whole prompt, cache included. The CLI measures its
*    `context_usage_ratio` as `input_tokens / window` (a probe: 9 811 input at
*    a 200 000 window → exactly 0.049055) and subtracts the cached part
*    afterwards for its own telemetry — so the harness's four buckets, which
*    are disjoint, have to take both cache halves back out of `inputTokens`.
* 2. Both cache buckets are always reported, zero included. The harness shows a
*    turn's usage only when its accounting is complete: a missing cache bucket
*    with no `totalTokens` to prove the sum makes the whole disclosure
*    unavailable, so omitting a zero would hide every per-turn usage row.
* 3. `totalTokens` is the sum of the four buckets, so the harness's
*    consistency check (`total - output == input + cacheRead + cacheWrite`)
*    holds by construction.
*
* @param real - the CLI's usage frame, or undefined when it reported none.
* @param reasoning - the local reasoning estimate, clamped inside the provider's
*   own output total (the harness drops a reading whose reasoning exceeds it).
* @returns the harness usage, or undefined when the frame carries no metering.
*/
function meteredUsage(real, reasoning) {
	if (real === void 0 || typeof real.input_tokens !== "number" || typeof real.output_tokens !== "number" || real.input_tokens <= 0 && real.output_tokens <= 0) return void 0;
	const cacheReadTokens = typeof real.cache_read_input_tokens === "number" ? real.cache_read_input_tokens : 0;
	const cacheWriteTokens = typeof real.cache_creation_input_tokens === "number" ? real.cache_creation_input_tokens : 0;
	const inputTokens = Math.max(0, real.input_tokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = real.output_tokens;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
		...reasoning(outputTokens)
	};
}
/**
* The host tool runtime dispatches by the bare host name; the inner model
* only ever sees the namespaced MCP form, so strip the prefix on the way out.
*/
function hostToolName$1(name) {
	return name.startsWith(MCP_TOOL_PREFIX$1) ? name.slice(MCP_TOOL_PREFIX$1.length) : name;
}
/** Deny native tools, allow this adapter's MCP tools. */
async function gateTools(toolName, _input, options) {
	const echo = options.toolUseID !== void 0 ? { toolUseID: options.toolUseID } : {};
	if (toolName.startsWith(MCP_TOOL_PREFIX$1)) return {
		behavior: "allow",
		...echo
	};
	return {
		behavior: "deny",
		message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
		...echo
	};
}
/** Message the inner model reads when a host turn superseded a parked call. */
const SUPERSEDED_CALL_TEXT = "[宿主取消了这次工具执行]";
/** Payload for a call the host request that followed it did not answer. */
function unansweredCall(toolUseId) {
	return {
		content: [{
			type: "text",
			text: `宿主未返回这次工具调用的结果（toolUseId=${toolUseId}），本次工具调用已取消`
		}],
		isError: true
	};
}
/**
* The tool-result bridge between the inner CLI and the host.
*
* qodercli announces a tool call twice, under two different identities:
* `canUseTool` receives the CLI's own tool-use id *before* the call runs, while
* the MCP `tools/call` handler that actually needs the host's result receives no
* id at all. The two arrive in the same order, so a FIFO pairs them — and the
* handler then parks under the exact id the host's result was filed under.
*
* ## Why that FIFO belongs to the session, not to a turn
*
* Measured against a live CLI, the handler can fire *after* the turn it belongs
* to has already ended. The host answers a tool call as soon as it sees the
* block, so the adapter's `deliverToolResults` files the result while nothing is
* parked yet, and only then does the CLI get around to dispatching the MCP call:
*
* ```
* 6198ms  [endTurn] kind=tool-calls
* 6198ms  [host] no parked handler -> BUFFERED under key=call_80d292a7…
* 6217ms  [mcp handler] ENTER | shifted toolUseId=undefined
* 6217ms  [mcp handler] PARKING under key=anonymous-1
* 14226ms [mcp handler] TIMED OUT after 8009ms
* ```
*
* Clearing the announcements at the turn boundary therefore threw away the very
* id the handler was about to claim. The handler fell through to a fallback key
* nothing could resolve, parked for the whole tool-result timeout, and the turn
* stalled — 120 s by default, which the user reads as "the model stopped
* answering" and works around by stopping the conversation and resending. The
* stall is probabilistic because a *slow* host tool (a shell command) parks its
* handler before the turn ends and takes the other path, while a fast one
* (`read`, `ask_user_question`) loses the race.
*
* ## Why a parked call must not have a wall-clock deadline
*
* A host result can only arrive on the next host request: the host runs every
* tool of the round first, then sends one request carrying all their results.
* A host tool is allowed to run for minutes (a build, a directory scan, a long
* shell command), and one slow tool delays the results of its whole batch. A
* fixed 120 s deadline therefore cancels calls whose real result is still on
* its way:
*
* ```
* 10:07:53  [mcp handler] PARK call_00_QFqbaum… (write — result ready at once)
* 10:07:53  [host]         pwsh starts (its own timeout: 300 s)
* 10:09:53  [mcp handler] TIMED OUT after 120s   <- write cancelled for nothing
* 10:10:38  [host]         first request arrives with all three results
* ```
*
* The request boundary is the real signal: the request that continues a tool
* round carries a result for every call the host answered; a call it did not
* answer in that request will never be answered. {@link beginHostRequest}
* settles those, so a slow host never loses a result it was about to send.
* Only a handler with no announced id — where no result can be matched at all
* — keeps a bounded park as the last-resort recovery.
*
* ## Why the boundary alone is not enough
*
* The boundary settles what is *already* parked when it runs, and an
* announcement that arrives after it is not touched by it. That leaves one
* shape a wall clock used to break and nothing else could: the CLI dispatches
* an MCP call whose tool-use block never reached the host. No result can be
* filed for that id, and the boundary that would settle it needs the next host
* request — which needs this turn to end first, and this turn is blocked on the
* handler. The turn hangs until the user stops it. {@link claim} therefore
* checks {@link ToolResultPairing.hostVisible} before parking: a call the host
* was never shown fails at once, exactly as the boundary would have failed it.
*
* Announcements are dropped only where the CLI provably cancels its pending
* dispatch — {@link forgetUnclaimed} on an aborted or failed turn, and
* {@link clear} when the session dies.
*/
var ToolResultPairing = class {
	/** Handlers parked under the tool-use id their host result will arrive as. */
	parked = /* @__PURE__ */ new Map();
	/** Results that arrived before their handler did, by tool-use id. */
	buffered = /* @__PURE__ */ new Map();
	/** Tool-use ids `canUseTool` allowed, in execution order, awaiting a handler. */
	announced = [];
	/**
	* Announcements a host request has moved past without answering.
	*
	* A handler for one of these can still fire (the CLI decides when to dispatch
	* the MCP call), but no result will ever arrive for it; {@link claim} settles
	* it immediately instead of parking it for the fallback timeout.
	*/
	abandoned = [];
	/**
	* Host callId (`qoder-N`) → qodercli tool-use id, from the content-block ids.
	*
	* Keyed by a per-session nonce, so a stale entry can never be reached by a
	* later call and is safe to keep across turns; it is dropped with the session.
	*/
	hostCallIds = /* @__PURE__ */ new Map();
	/**
	* Tool-use ids the host was actually shown, and has not answered yet.
	*
	* A host result is filed under a tool-use id only because the adapter emitted
	* that call's block to the host, so these — and only these — are calls the
	* host can still answer. {@link claim} refuses to park on any other id; see
	* the deadlock it prevents there. Mirrors the values of {@link hostCallIds}
	* and is cleared everywhere that map is.
	*/
	hostVisible = /* @__PURE__ */ new Set();
	/** Suffix for a handler that claimed no announcement, so keys stay distinct. */
	anonymous = 0;
	/** Record the tool-use id `canUseTool` allowed, in execution order. */
	announce(toolUseId) {
		this.announced.push(toolUseId);
	}
	/** Record which tool-use id a model-emitted tool-call block belongs to. */
	mapHostCall(hostCallId, toolUseId) {
		this.hostCallIds.set(hostCallId, toolUseId);
		this.hostVisible.add(toolUseId);
	}
	/**
	* Hand one MCP handler the result the host already delivered, or park it until
	* the host delivers one.
	*
	* A paired call is NOT timed out. The host can only answer on its next
	* request, and a host tool may legitimately run for minutes; the next request
	* settles it instead — see {@link beginHostRequest}. `timeoutMs` is therefore
	* reached only by a handler the CLI never announced, where no id exists to
	* match a result against and a bounded park remains the last resort.
	*
	* Parking forever is safe only for a call the host was shown; an announced id
	* the host never received fails at once rather than hanging the turn. See the
	* measurement in the body.
	*
	* @param timeoutMs - how long an *unpaired* handler waits before failing.
	* @returns the host's result, a cancellation, or a timeout payload.
	*/
	async claim(timeoutMs) {
		const toolUseId = this.announced.shift();
		if (toolUseId !== void 0) {
			const ready = this.buffered.get(toolUseId);
			if (ready !== void 0) {
				this.buffered.delete(toolUseId);
				return ready;
			}
			if (!this.hostVisible.has(toolUseId)) return unansweredCall(toolUseId);
			return await this.park(toolUseId);
		}
		const abandoned = this.abandoned.shift();
		if (abandoned !== void 0) return unansweredCall(abandoned);
		if (this.parked.size === 0 && this.buffered.size === 1) {
			const only = this.buffered.entries().next();
			if (only.done !== true) {
				this.buffered.delete(only.value[0]);
				return only.value[1];
			}
		}
		return await this.park(`anonymous-${++this.anonymous}`, timeoutMs);
	}
	/**
	* Park one handler under `key` until the host answers, the request boundary
	* settles it, or — for an unpaired key only — the fallback timeout expires.
	*/
	async park(key, timeoutMs) {
		return await new Promise((resolve) => {
			let timer;
			if (timeoutMs !== void 0) timer = setTimeout(() => {
				this.parked.delete(key);
				resolve({
					content: [{
						type: "text",
						text: `宿主在 ${timeoutMs / 1e3}s 内未返回工具结果（toolUseId=${key}），本次工具调用已取消`
					}],
					isError: true
				});
			}, timeoutMs);
			this.parked.set(key, (payload) => {
				if (timer !== void 0) clearTimeout(timer);
				resolve(payload);
			});
		});
	}
	/**
	* File one host tool result against the call it answers.
	*
	* Resolves the handler already parked under that tool-use id, or buffers the
	* result for the handler that has not fired yet — which is the ordinary case
	* for a host tool that returns quickly.
	*
	* @param hostCallId - the host-facing call id from the tool-result message.
	* @param payload - the rendered result.
	* @returns the tool-use id the result was filed under, for the request
	*   boundary that settles the rest of the round.
	*/
	deliver(hostCallId, payload) {
		const key = this.hostCallIds.get(hostCallId) ?? hostCallId;
		this.hostCallIds.delete(hostCallId);
		this.hostVisible.delete(key);
		const resolve = this.parked.get(key);
		if (resolve !== void 0) {
			this.parked.delete(key);
			resolve(payload);
			return key;
		}
		this.buffered.set(key, payload);
		return key;
	}
	/**
	* Settle the pairing against one arriving host request.
	*
	* The host runs every tool of a round before it sends the request that
	* continues the conversation, and that request carries a result for every
	* call it answered. A call it did not answer there will never be answered,
	* so this boundary — not a wall clock — decides that a handler is stranded:
	*
	*  - a handler parked under an unanswered id is released now;
	*  - an announcement whose handler has not fired yet is marked abandoned, so
	*    that handler settles as soon as it does arrive;
	*  - a buffered result from an earlier round whose handler never arrived is
	*    dropped, because no later request can produce that handler.
	*
	* A fresh user turn is handled by the same rules: the results the request
	* still carries are delivered, and the calls it left unanswered are
	* superseded. It differs only in the cancellation text the model reads.
	*
	* `delivered` is what protects the fast-handler race: a result can arrive
	* before the CLI dispatches the MCP handler, and a runtime-context snapshot
	* can make the same request look like a new user turn. Keeping everything
	* this request answered, in both cases, is what lets that handler collect
	* the real result instead of a cancellation.
	*
	* @param delivered - tool-use ids the host just delivered a result for.
	* @param freshUserTurn - whether the request carries a new user message.
	*/
	beginHostRequest(delivered, freshUserTurn) {
		if (this.announced.length === 0 && this.parked.size === 0) this.abandoned.length = 0;
		for (const [key, resolve] of [...this.parked.entries()]) {
			if (delivered.has(key)) continue;
			this.parked.delete(key);
			resolve(freshUserTurn ? {
				content: [{
					type: "text",
					text: SUPERSEDED_CALL_TEXT
				}],
				isError: true
			} : unansweredCall(key));
		}
		const kept = this.announced.filter((id) => delivered.has(id));
		for (const id of this.announced) if (!delivered.has(id)) this.abandoned.push(id);
		this.announced.length = 0;
		this.announced.push(...kept);
		for (const key of [...this.buffered.keys()]) if (!delivered.has(key)) this.buffered.delete(key);
		this.hostCallIds.clear();
		this.hostVisible.clear();
	}
	/**
	* Release every parked handler: the host started a fresh user turn while their
	* calls were still outstanding, so those calls can never be answered.
	*/
	cancelParked() {
		const stale = [...this.parked.entries()];
		this.parked.clear();
		for (const [, resolve] of stale) resolve({
			content: [{
				type: "text",
				text: SUPERSEDED_CALL_TEXT
			}],
			isError: true
		});
	}
	/**
	* Drop announcements no handler can still claim, and release parked handlers.
	*
	* An aborted or failed turn is one where the CLI cancels its pending tool
	* dispatch, so an id it announced but never dispatched would otherwise shift
	* the pairing of the NEXT turn's handler by one slot and park it under a key
	* nothing resolves — reintroducing the very stall this class exists to fix.
	* A handler that was already dispatched still needs an answer, so parked
	* handlers settle here, and announcements move to the abandoned queue in case
	* their dispatch was already in flight when the turn died.
	*/
	forgetUnclaimed() {
		this.abandoned.push(...this.announced);
		this.announced.length = 0;
		this.cancelParked();
		this.buffered.clear();
		this.hostCallIds.clear();
		this.hostVisible.clear();
	}
	/** Drop all pairing state; the session is being torn down. */
	clear() {
		this.cancelParked();
		this.announced.length = 0;
		this.abandoned.length = 0;
		this.hostCallIds.clear();
		this.hostVisible.clear();
		this.buffered.clear();
	}
	/** How many handlers are waiting for a host result. */
	get parkedCount() {
		return this.parked.size;
	}
};
/**
* One warm inner session. All mutation happens on the consumer fiber except
* the documented turn lifecycle driven by {@link stream}.
*/
var QoderSession = class {
	sessionId;
	channel = createChannel();
	/**
	* Lazy: the MCP SDK refuses tool registration after the transport connects,
	* so the inner process only spawns once {@link ensureTools} has registered
	* the host tools (the adapter does that immediately before each stream).
	*/
	q = null;
	/**
	* Tool-result pairing state. Owned by the session rather than the turn,
	* because a handler can fire after its turn has ended — see
	* {@link ToolResultPairing} for the measurement that proves it.
	*/
	pairing = new ToolResultPairing();
	mcp = createSdkMcpServer({
		name: MCP_SERVER_NAME,
		tools: []
	});
	registered = /* @__PURE__ */ new Map();
	queue = null;
	model;
	reasoningEffort;
	callCounter = 0;
	/**
	* Per-instance suffix for emitted host call ids. Ids must stay unique across
	* the whole host session log: a history divergence rebuilds this class, LRU
	* eviction recreates it, and the harness keys tool-call blocks by id, so a
	* fresh `qoder-1` would collide with the one its predecessor already stored.
	*/
	callNonce = randomUUID().slice(0, 8);
	abortPending = false;
	disposed = false;
	/**
	* How the active turn ended, so its cleanup can tell a completed turn (whose
	* unclaimed announcements may still belong to a handler about to fire) from an
	* aborted or failed one (where the CLI cancelled that dispatch).
	*/
	turnEndKind = void 0;
	/** Previous request's messages for delta feeding. */
	fedMessages;
	fedSystem;
	/** This turn's fed characters, reset per turn for per-call token accounting. */
	turnInputChars = 0;
	/** Host system prompt captured before spawn for the boot-time systemPrompt. */
	hostSystem;
	/** Host session workspace; qodercli runs there so its preset reports the session cwd. */
	sessionCwd;
	blockIndex = 0;
	textBlock;
	reasoningBlock;
	openTool;
	toolCalls = [];
	/**
	* This turn's generated output, priced by script.
	*
	* Counts visible text, reasoning, and tool-call names and arguments — see
	* {@link TurnOutputAccounting} for why the last one matters.
	*/
	output = new TurnOutputAccounting();
	/**
	* Metering of the last provider request that finished in the active turn.
	*
	* Never the `result` frame's usage, which totals the whole inner turn across
	* every request it made — see {@link requestUsageSample}.
	*/
	lastUsage;
	/**
	* The active turn's feed as plain text, when that feed carries image bytes.
	* Kept so a CLI that refuses to decode those bytes can be retried without
	* them instead of failing the turn. Cleared with the turn.
	*/
	feedFallback;
	/**
	* Session-level input token estimate for the CURRENT request, priced by
	* script mix over the rendered conversation the inner session actually
	* receives. It is the last-resort tier of {@link usage}: a turn whose frames
	* carry no metering at all would otherwise read ~0% on the context meter and
	* never trigger auto-compaction, and the CLI's own context ratio is preferred
	* over this whenever the turn reported one.
	*/
	estimatedInputTokens;
	/**
	* The window this route publishes, i.e. the denominator the harness meter
	* divides by. The CLI's context ratio is turned into tokens against this same
	* number, so the meter and the ratio always describe one window.
	*/
	contextWindow;
	/**
	* The window the CLI will actually run with, when that is known to differ
	* from {@link contextWindow} because the model does not advertise the
	* declared one. This is the denominator the CLI itself measures its context
	* ratio against, so it is what the ratio must be multiplied by.
	*/
	cliContextWindow;
	/** Per-session runtime knobs, resolved from the plugin config at creation. */
	toolResultTimeoutMs;
	abortGraceMs;
	/** Which edition's CLI (and SDK) this session runs on. */
	brand;
	constructor(sessionId, initialModel, runtime = {}) {
		this.sessionId = sessionId;
		this.model = initialModel;
		this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, DEFAULT_TOOL_RESULT_TIMEOUT_MS);
		this.abortGraceMs = readLive(runtime.abortGraceMs, DEFAULT_ABORT_GRACE_MS);
		this.brand = runtime.brand ?? "cn";
	}
	/** Spawn the inner process (first stream only) and attach the consumer. */
	async ensureStarted() {
		if (this.q !== null) return this.q;
		if (foreignCliOverride(this.brand) !== void 0) throw new Error(cliConflictMessage(this.brand));
		if (resolveQoderCli(this.brand) === void 0) throw new Error(cliConflictMessage(this.brand));
		try {
			await probeDaemon(this.brand);
		} catch (error) {
			if (isDaemonConflict(error)) resetSdk(this.brand);
		}
		const sdk = await loadSdk(this.brand);
		const q = sdk.query({
			prompt: this.channel,
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				canUseTool: this.canUseTool,
				settingSources: [],
				includePartialMessages: true,
				resolveModel: () => ({
					model: this.model,
					...this.reasoningEffort === void 0 && this.contextWindow === void 0 ? {} : { parameters: {
						...this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort },
						...this.contextWindow === void 0 ? {} : { contextWindow: this.contextWindow }
					} }
				}),
				mcpServers: { [MCP_SERVER_NAME]: this.mcp },
				allowedMcpServerNames: [MCP_SERVER_NAME],
				...this.hostSystem === void 0 ? {} : { systemPrompt: this.hostSystem },
				...this.sessionCwd === void 0 ? {} : { cwd: this.sessionCwd }
			}
		});
		this.q = q;
		this.consume(q);
		return q;
	}
	/** Point the session at a model and its per-request policy. */
	setModel(model, policy) {
		this.model = model;
		this.reasoningEffort = policy?.reasoningEffort;
		this.contextWindow = policy?.contextWindow;
		this.cliContextWindow = policy?.cliContextWindow;
	}
	/** Record the host system prompt; effective only before the process spawns. */
	setSystem(system) {
		this.hostSystem = system;
	}
	/**
	* Record the host session workspace; effective only before the process
	* spawns. qodercli inherits the host process cwd otherwise, which would
	* make its preset report the server's launch directory instead of the
	* session's workspace.
	*/
	setCwd(cwd) {
		this.sessionCwd = cwd;
	}
	/**
	* Permission gate for the inner process. Native tools are denied; MCP host
	* tools are allowed, and each allowed call's qodercli tool-use id is recorded
	* so the matching MCP handler can park under the exact id (qodercli asks once
	* per call, in execution order, before dispatching the MCP message).
	*/
	canUseTool = (toolName, _input, options) => {
		if (toolName.startsWith(MCP_TOOL_PREFIX$1)) {
			if (options.toolUseID !== void 0) this.pairing.announce(options.toolUseID);
			return Promise.resolve({
				behavior: "allow",
				...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
			});
		}
		return Promise.resolve({
			behavior: "deny",
			message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
			...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
		});
	};
	/** Register any host tools whose schema this session's MCP server lacks. */
	ensureTools(tools) {
		for (const schema of tools) {
			const hash = JSON.stringify(schema.parameters ?? {});
			if (this.registered.get(schema.name) === hash) continue;
			const shape = jsonSchemaToShape(schema.parameters ?? {});
			try {
				this.mcp.instance.registerTool(schema.name, {
					description: schema.description.length > 0 ? schema.description : schema.name,
					inputSchema: shape
				}, async (args) => {
					const result = await this.pairing.claim(this.toolResultTimeoutMs);
					return {
						content: result.content,
						...result.isError ? { isError: true } : {}
					};
				});
			} catch {
				continue;
			}
			this.registered.set(schema.name, hash);
		}
	}
	/**
	* Deliver host tool results to parked or buffered handlers, keyed by call id,
	* and settle the previous round at this request boundary.
	* @param tail - the host messages appended since the previous request.
	* @param images - adapter-resolved request images keyed by attachment id; an
	*   id missing from the map degrades to handle text.
	*/
	deliverToolResults(tail, images) {
		let freshUserTurn = false;
		const delivered = /* @__PURE__ */ new Set();
		for (const message of tail) {
			if (message.role === "user") {
				freshUserTurn = true;
				continue;
			}
			if (message.role !== "tool") continue;
			delivered.add(this.pairing.deliver(String(message.toolCallId), {
				content: renderResultContent(message.content, images),
				isError: message.isError === true
			}));
		}
		this.pairing.beginHostRequest(delivered, freshUserTurn);
	}
	/**
	* Run one inner turn: feed (if any) then pump consumer chunks until finish.
	* @param options - the host request (signal; tools already registered).
	* @param feed - literal text, resolved content blocks (a vision turn), or
	*   null for a pure tool-result continuation.
	* @param fallback - the same feed rendered as text. Used only if the inner
	*   CLI refuses the turn's image bytes, in which case the turn is resent
	*   without them rather than failing (see {@link retryWithoutImages}).
	*/
	async *stream(options, feed, fallback) {
		if (this.queue !== null) throw new LlmError(`qoder session ${this.sessionId} already has a turn in flight`, "CONFLICT");
		if (this.disposed) throw new LlmError(`qoder session ${this.sessionId} was disposed`, "TRANSPORT");
		const q = await this.ensureStarted();
		this.queue = new TurnQueue();
		this.resetTurnState();
		if (feed !== null) {
			const content = typeof feed === "string" ? [{
				type: "text",
				text: feed
			}] : [...feed];
			this.feedFallback = fallback !== void 0 && content.some((block) => block.type === "image") ? fallback : void 0;
			this.turnInputChars += contentChars$1(content);
			this.channel.push({
				type: "user",
				message: {
					role: "user",
					content
				},
				parent_tool_use_id: null
			});
		}
		const signal = options.signal;
		let abortTimer;
		const onAbort = () => {
			this.abortPending = true;
			q.interrupt().catch(() => void 0);
			abortTimer = setTimeout(() => this.endTurn({
				kind: "aborted",
				failure: {
					message: "qoder session aborted by host",
					code: "ABORTED"
				}
			}), this.abortGraceMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			for await (const item of this.queue) {
				if (item.kind === "chunk") {
					yield item.chunk;
					continue;
				}
				if (item.usage !== void 0) yield {
					type: "usage",
					usage: this.usage()
				};
				yield {
					type: "finish",
					reason: item.reason
				};
				return;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (abortTimer !== void 0) clearTimeout(abortTimer);
			if (this.turnEndKind === "aborted" || this.turnEndKind === "error") this.pairing.forgetUnclaimed();
			this.queue = null;
			this.abortPending = false;
			this.feedFallback = void 0;
		}
	}
	/**
	* Resend the current turn without its images after the CLI refused them.
	*
	* The inner CLI decodes every image before the model sees the turn, and a
	* decode it cannot do fails that whole turn — the host would surface an error
	* for a question whose only problem was the pixels. The failed turn never
	* reached the model, so the same turn goes out again with the images replaced
	* by the harness's own handle text, the same text a text-only route renders,
	* and the user still gets an answer.
	*
	* @param detail - the failed result frame's subtype and errors.
	* @returns whether a retry was started, in which case the turn must not be
	*   ended: the retry's own result frame settles it.
	*/
	retryWithoutImages(detail) {
		const fallback = this.feedFallback;
		if (fallback === void 0 || !isImageAttachFailure(detail)) return false;
		if (this.textBlock !== void 0 || this.reasoningBlock !== void 0 || this.toolCalls.length > 0 || this.output.outputChars > 0) return false;
		this.feedFallback = void 0;
		this.resetTurnState();
		this.turnInputChars += fallback.length;
		this.channel.push({
			type: "user",
			message: {
				role: "user",
				content: [{
					type: "text",
					text: fallback
				}]
			},
			parent_tool_use_id: null
		});
		return true;
	}
	/** Tear the inner process down; parked calls die with it. */
	close() {
		if (this.disposed) return;
		this.disposed = true;
		this.pairing.clear();
		if (this.q !== null) this.q.close().catch(() => void 0);
	}
	/**
	* Reset the per-turn assembly state.
	*
	* Pairing state is deliberately NOT touched here. It looks turn-scoped, but a
	* `tools/call` handler can fire only after the turn that announced it has
	* already ended — the host answers a tool call the moment it sees the block,
	* and the CLI dispatches the MCP message some milliseconds later. Clearing
	* announcements at this boundary made that handler claim nothing, park under a
	* fallback key, and wait out the whole tool-result timeout; see
	* {@link ToolResultPairing}. {@link QoderSession.close} drops it with the
	* session, and an aborted turn drops what it can no longer claim.
	*/
	resetTurnState() {
		this.blockIndex = 0;
		this.textBlock = void 0;
		this.reasoningBlock = void 0;
		this.openTool = void 0;
		this.toolCalls = [];
		this.turnInputChars = 0;
		this.output.reset();
		this.lastUsage = void 0;
		this.turnEndKind = void 0;
	}
	emit(chunk) {
		this.queue?.push({
			kind: "chunk",
			chunk
		});
	}
	/** Count generated text toward this turn's output tokens. */
	countOutput(text) {
		this.output.addOutput(text);
	}
	/**
	* Price this turn's generated text, by script rather than at a flat rate.
	*
	* {@link TurnOutputAccounting} owns the counters and the harness invariant
	* that `reasoningTokens` is a subset of `outputTokens` — the harness discards
	* a whole reading when it is not.
	*/
	outputUsage() {
		return this.output.usage();
	}
	usage() {
		const metered = meteredUsage(this.lastUsage, (output) => this.output.reasoningTokensWithin(output));
		if (metered !== void 0) return metered;
		const ratioWindow = this.cliContextWindow ?? this.contextWindow;
		const ratio = this.lastUsage?.context_usage_ratio;
		if (typeof ratio === "number" && ratio > 0 && typeof ratioWindow === "number" && ratioWindow > 0) return this.estimatedUsage(Math.min(ratioWindow, Math.max(1, Math.ceil(ratio * ratioWindow))));
		if (this.estimatedInputTokens !== void 0 && this.estimatedInputTokens > 0) return this.estimatedUsage(this.estimatedInputTokens);
		return this.estimatedUsage(Math.max(1, Math.ceil(this.turnInputChars / 4)));
	}
	/**
	* One estimated turn reading, shaped exactly like a metered one.
	*
	* The cache buckets are present and zero rather than omitted: this estimate
	* prices the prompt as a single uncached block, and a missing bucket would
	* make the harness withhold the turn's usage disclosure entirely.
	*
	* @param inputTokens - the estimated prompt size, uncached by definition.
	* @returns the harness usage for the turn.
	*/
	estimatedUsage(inputTokens) {
		const output = this.outputUsage();
		return {
			inputTokens,
			...output,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: inputTokens + output.outputTokens
		};
	}
	/**
	* Record the input-token estimate for the CURRENT request, priced by script
	* mix over the rendered conversation (system + messages) the inner session
	* receives. This is the fallback {@link usage} reaches for only when a turn
	* reported no metering and no context ratio — without it such a turn would
	* read ~0% on the context meter and never trigger auto-compaction.
	* @param system - the host system prompt included in this request.
	* @param messages - the full host message list included in this request.
	*/
	recordRequestInput(system, messages) {
		const rendered = renderInitialFeed(system, messages);
		const imageTokens = feedImageRefs(rendered).reduce((total, ref) => total + estimateImageTokens(ref.width, ref.height), 0);
		this.estimatedInputTokens = Math.max(1, Math.ceil(estimateTextTokens(feedTextLength(rendered), feedWideCharCount(rendered))) + imageTokens);
	}
	endTurn(reason, usage) {
		if (this.queue === null) return;
		this.turnEndKind = reason.kind;
		if (this.textBlock !== void 0) this.emit({
			type: "block-end",
			index: this.textBlock.index,
			block: {
				type: "text",
				text: this.textBlock.text
			}
		});
		if (this.reasoningBlock !== void 0) this.emit({
			type: "block-end",
			index: this.reasoningBlock.index,
			block: {
				type: "reasoning",
				text: this.reasoningBlock.text
			}
		});
		this.queue.push({
			kind: "turn-end",
			reason,
			usage: usage ?? this.usage()
		});
		this.queue.close();
	}
	async consume(q) {
		try {
			const iterator = q[Symbol.asyncIterator]();
			while (true) {
				const next = await iterator.next();
				if (next.done) break;
				try {
					this.handle(next.value);
				} catch (error) {
					this.endTurn({
						kind: "error",
						failure: {
							message: `qoder session consumer failed: ${String(error)}`,
							code: "BACKEND_ERROR"
						}
					});
				}
			}
			this.endTurn({
				kind: "error",
				failure: {
					message: "qoder session stream ended unexpectedly",
					code: "STREAM_CLOSED"
				}
			});
		} catch (error) {
			if (isDaemonConflict(error)) {
				resetSdk(this.brand);
				this.q = null;
				q.close().catch(() => void 0);
			}
			this.endTurn({
				kind: "error",
				failure: {
					message: `qoder session died: ${cliFailureText(String(error), this.brand)}`,
					code: "TRANSPORT"
				}
			});
		}
	}
	handle(message) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event === void 0) return;
			const sample = requestUsageSample(message);
			if (sample !== void 0) this.lastUsage = sample;
			switch (event.type) {
				case "content_block_start": {
					const block = event.content_block;
					if (block?.type === "tool_use") {
						if (this.queue === null || this.queue.isClosed) break;
						const callId = `qoder-${this.callNonce}-${++this.callCounter}`;
						if (typeof block.id === "string" && block.id.length > 0) this.pairing.mapHostCall(callId, block.id);
						const chunkIndex = this.blockIndex++;
						const initialArguments = block.input !== void 0 && block.input !== null && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
						this.openTool = {
							chunkIndex,
							callId,
							name: hostToolName$1(block.name ?? ""),
							arguments: initialArguments
						};
						this.countOutput(this.openTool.name);
						this.countOutput(initialArguments);
						this.emit({
							type: "block-start",
							index: chunkIndex,
							blockType: "tool-call"
						});
						this.emit({
							type: "tool-call-delta",
							index: chunkIndex,
							id: ToolCallId(callId),
							name: this.openTool.name,
							argumentsDelta: ""
						});
					}
					break;
				}
				case "content_block_delta": {
					const delta = event.delta;
					if (delta === void 0) return;
					if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
						if (this.textBlock === void 0) {
							this.textBlock = {
								index: this.blockIndex++,
								text: ""
							};
							this.emit({
								type: "block-start",
								index: this.textBlock.index,
								blockType: "text"
							});
						}
						this.textBlock.text += delta.text;
						this.countOutput(delta.text);
						this.emit({
							type: "text-delta",
							index: this.textBlock.index,
							text: delta.text
						});
					} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
						if (this.reasoningBlock === void 0) {
							this.reasoningBlock = {
								index: this.blockIndex++,
								text: ""
							};
							this.emit({
								type: "block-start",
								index: this.reasoningBlock.index,
								blockType: "reasoning"
							});
						}
						this.reasoningBlock.text += delta.thinking;
						this.output.addReasoning(delta.thinking);
						this.emit({
							type: "reasoning-delta",
							index: this.reasoningBlock.index,
							text: delta.thinking
						});
					} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && this.openTool !== void 0) {
						this.openTool.arguments += delta.partial_json;
						this.countOutput(delta.partial_json);
						this.emit({
							type: "tool-call-delta",
							index: this.openTool.chunkIndex,
							id: ToolCallId(this.openTool.callId),
							argumentsDelta: delta.partial_json
						});
					}
					break;
				}
				case "content_block_stop":
					if (this.openTool !== void 0) {
						this.emit({
							type: "block-end",
							index: this.openTool.chunkIndex,
							block: {
								type: "tool-call",
								id: ToolCallId(this.openTool.callId),
								name: this.openTool.name,
								arguments: this.openTool.arguments
							}
						});
						this.toolCalls.push(this.openTool);
						this.openTool = void 0;
					}
					break;
				case "message_stop": if (this.toolCalls.length > 0) this.endTurn({ kind: "tool-calls" });
			}
			return;
		}
		if (message.type === "assistant") {
			if (this.textBlock === void 0 && this.toolCalls.length === 0) {
				const content = message.message?.content ?? [];
				for (const block of content) {
					if (block.type !== "tool_use") continue;
					this.countOutput(block.name ?? "");
					this.countOutput(JSON.stringify(block.input ?? ""));
				}
				const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
				if (text.length > 0) {
					this.textBlock = {
						index: this.blockIndex++,
						text
					};
					this.countOutput(text);
					this.emit({
						type: "block-start",
						index: this.textBlock.index,
						blockType: "text"
					});
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text
					});
				}
			}
			return;
		}
		if (message.type === "result") {
			if (this.abortPending) {
				this.endTurn({
					kind: "aborted",
					failure: {
						message: "qoder turn aborted by host",
						code: "ABORTED"
					}
				});
				return;
			}
			if (this.toolCalls.length > 0) {
				this.endTurn({ kind: "tool-calls" });
				return;
			}
			if (message.subtype === "success" || message.subtype === void 0) {
				if (this.textBlock === void 0 && this.reasoningBlock === void 0) this.endTurn({
					kind: "error",
					failure: {
						message: "qoder model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				});
				else this.endTurn({ kind: "stop" });
				return;
			}
			const detail = `${message.subtype} ${safeErrors(message.errors)}`;
			if (this.retryWithoutImages(detail)) return;
			this.endTurn({
				kind: "error",
				failure: {
					message: `qoder turn failed: ${detail}`,
					code: classifyTurnError(detail)
				}
			});
		}
	}
};
/**
* Render tool-result content blocks into the MCP content the inner model
* reads: text passes through, an image resolves from {@link images} into the
* MCP image shape or degrades to the harness's own handle text, and anything
* else is serialized.
*/
function renderResultContent(blocks, images) {
	const content = [];
	for (const block of blocks) if (block.type === "text") content.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") {
		const resolved = images?.get(String(block.attachment.attachmentId));
		if (resolved !== void 0) content.push({
			type: "image",
			data: resolved.data,
			mimeType: resolved.mediaType
		});
		else content.push({
			type: "text",
			text: textOnlyImageText(block.attachment)
		});
	} else content.push({
		type: "text",
		text: JSON.stringify(block)
	});
	return content;
}
/**
* Vision tokens for one image, estimated with the tile formula the
* Claude-compatible wire shape this backend follows uses (width x height / 750).
* The inner CLI reports no usage for the pixels it consumed, so this estimate is
* the only image occupancy the harness context meter and compaction threshold
* can see. It is an estimate, not a provider metering figure.
*/
function estimateImageTokens(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
	return Math.max(1, Math.ceil(width * height / 750));
}
/** Literal characters one channel content list contributes to the fallback estimate. */
function contentChars$1(content) {
	return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}
/** Safely stringify the SDK error payload for turn diagnostics. */
function safeErrors(errors) {
	if (errors === void 0) return "";
	if (typeof errors === "string") return errors;
	try {
		return JSON.stringify(errors);
	} catch {
		return String(errors);
	}
}
/**
* Classify an inner result-frame failure into a harness-routable code. The
* qoder backend reports context-window and quota rejections as generic
* per-turn errors, so their message text must be recognized through the shared
* dsh-llm classifiers; only then does the harness overflow recovery (or quota
* surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
*/
function classifyTurnError(detail) {
	if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	return "BACKEND_TURN_ERROR";
}
/**
* Whether a failed turn is the CLI refusing an image it could not decode.
*
* qodercli decodes every attached image before the model sees the turn, and
* reports such a failure with a fixed set of phrasings: the sentence it shows
* the user, its terminal reason, and the error code underneath. The turn itself
* is fine — only the pixels are not, which is what makes it safe to resend.
*
* @param detail - the failed result frame's subtype and errors.
*/
function isImageAttachFailure(detail) {
	return /image_processing_failed|unable to attach image|invalid or unsupported image data/i.test(detail);
}
/**
* Warm-session registry with insertion-order LRU eviction, plus the cold
* one-shot path for side-channel requests (titles, compaction).
*/
var QoderSessionManager = class {
	maxSessions;
	runtime;
	sessions = /* @__PURE__ */ new Map();
	/**
	* @param maxSessions - warm-session cap; read per eviction so a settings edit
	*   applies to the next session that overflows the pool.
	* @param runtime - per-session knobs, resolved when each session is created.
	*/
	constructor(maxSessions = 8, runtime = {}) {
		this.maxSessions = maxSessions;
		this.runtime = runtime;
	}
	/** Existing or fresh warm session for one host session id. */
	forSession(sessionId, model) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			this.sessions.delete(sessionId);
			this.sessions.set(sessionId, existing);
			return existing;
		}
		const session = new QoderSession(sessionId, model, this.runtime);
		this.sessions.set(sessionId, session);
		const cap = readLive(this.maxSessions, 8);
		while (this.sessions.size > cap) {
			const oldest = this.sessions.keys().next();
			if (oldest.done === true) break;
			const victim = this.sessions.get(oldest.value);
			this.sessions.delete(oldest.value);
			victim?.close();
		}
		return session;
	}
	/** Drop one session (history diverged); the next request rebuilds it cold. */
	dispose(sessionId) {
		const session = this.sessions.get(sessionId);
		if (session === void 0) return;
		this.sessions.delete(sessionId);
		session.close();
	}
	closeAll() {
		for (const session of this.sessions.values()) session.close();
		this.sessions.clear();
	}
	/** One-shot turn with no warm state: side channels and cold rebuilds. */
	async *coldStream(options, prompt, model) {
		const systemPrompt = options.system;
		const brand = this.runtime.brand ?? "cn";
		if (foreignCliOverride(brand) !== void 0) throw new Error(cliConflictMessage(brand));
		if (resolveQoderCli(brand) === void 0) throw new Error(cliConflictMessage(brand));
		const sdk = await loadSdk(brand);
		const q = sdk.query({
			prompt,
			options: {
				...qoderCliOptions(brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				canUseTool: gateTools,
				settingSources: [],
				maxTurns: readLive(this.runtime.coldMaxTurns, DEFAULT_COLD_MAX_TURNS),
				...systemPrompt === void 0 ? {} : { systemPrompt },
				...model === void 0 ? {} : { model }
			}
		});
		const signal = options.signal;
		const onAbort = () => {
			q.interrupt().catch(() => void 0);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			let text = "";
			let failure;
			try {
				for await (const message of q) {
					const msg = message;
					if (msg.type === "assistant") {
						const chunk = (msg.message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
						if (chunk.length > 0) text += chunk;
					} else if (msg.type === "result" && msg.subtype !== "success" && msg.subtype !== void 0) {
						const detail = `${msg.subtype} ${safeErrors(msg.errors)}`;
						failure = {
							message: `qoder side-channel turn failed: ${detail}`,
							code: classifyTurnError(detail)
						};
					}
				}
			} catch (error) {
				if (signal?.aborted !== true) {
					if (isDaemonConflict(error)) resetSdk(brand);
					throw error;
				}
			}
			if (signal?.aborted === true) {
				yield {
					type: "finish",
					reason: {
						kind: "aborted",
						failure: {
							message: "aborted by host",
							code: "ABORTED"
						}
					}
				};
				return;
			}
			if (failure !== void 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure
					}
				};
				return;
			}
			if (text.length === 0) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: "qoder side-channel returned no content",
							code: EMPTY_RESPONSE_CODE
						}
					}
				};
				return;
			}
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			for (let i = 0; i < text.length; i += 192) yield {
				type: "text-delta",
				index: 0,
				text: text.slice(i, i + 192)
			};
			yield {
				type: "block-end",
				index: 0,
				block: {
					type: "text",
					text
				}
			};
			yield {
				type: "usage",
				usage: {
					inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
					outputTokens: Math.max(1, Math.ceil(text.length / 4))
				}
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			await q.close().catch(() => void 0);
		}
	}
};
//#endregion
//#region src/usage.ts
/** How long one quota reading stays fresh by default. */
const DEFAULT_USAGE_CACHE_TTL_MS = 6e4;
/** Upper bound on one quota round trip. */
const DEFAULT_USAGE_TIMEOUT_MS = 2e4;
/** Streaming prompt that never yields, so no model turn runs during the read. */
async function* inertInput$1() {
	await new Promise(() => {});
}
/** Cached quota reader for one brand. */
var QoderUsage = class {
	brand;
	ttlMs;
	timeoutMs;
	cached;
	inflight;
	/**
	* @param brand - which edition's CLI answers.
	* @param ttlMs - how long a reading stays fresh; read per use.
	* @param timeoutMs - how long one round trip may take.
	*/
	constructor(brand, ttlMs = DEFAULT_USAGE_CACHE_TTL_MS, timeoutMs = DEFAULT_USAGE_TIMEOUT_MS) {
		this.brand = brand;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/**
	* Read the quota, or serve the cached reading while it is still fresh.
	*
	* @param fresh - ignore the cache; the page's refresh button.
	* @returns the reading; `error` carries a failed lookup instead of throwing.
	*/
	async read(fresh = false) {
		if (resolveQoderCli(this.brand) === void 0) {
			this.cached = void 0;
			return this.missingCli();
		}
		const ttlMs = readLive(this.ttlMs, DEFAULT_USAGE_CACHE_TTL_MS);
		if (!fresh && this.cached !== void 0 && Date.now() - this.cached.at < ttlMs) return this.cached;
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = void 0;
		});
		const snapshot = await this.inflight;
		this.cached = snapshot;
		return snapshot;
	}
	/** Drop the cached reading. */
	invalidate() {
		this.cached = void 0;
	}
	/** The reading for a machine whose CLI is not installed. */
	missingCli() {
		const command = brandProfile(this.brand).cliCommands[0];
		return {
			at: Date.now(),
			cliMissing: true,
			error: `未检测到可用的 ${command}，请先安装并登录后再使用此版本。`
		};
	}
	async fetch() {
		const at = Date.now();
		try {
			if (foreignCliOverride(this.brand) !== void 0) return {
				at,
				cliMissing: true,
				error: cliConflictMessage(this.brand)
			};
			return await withSdk(this.brand, (sdk) => this.readSnapshot(sdk, at));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const command = brandProfile(this.brand).cliCommands[0];
			return {
				at,
				error: /ENOENT|not found|Cannot find package|未安装国际版 SDK/i.test(detail) ? `未检测到可用的 ${command}，请先安装并登录后再读取额度。` : cliFailureText(detail, this.brand)
			};
		}
	}
	async readSnapshot(sdk, at) {
		const timeoutMs = readLive(this.timeoutMs, DEFAULT_USAGE_TIMEOUT_MS);
		const q = sdk.query({
			prompt: inertInput$1(),
			options: {
				...qoderCliOptions(this.brand),
				auth: sdk.qodercliAuth(),
				tools: [],
				allowedTools: [],
				settingSources: [],
				maxTurns: 1
			}
		});
		try {
			const usage = await withTimeout$2(q.getUsageInfo(), timeoutMs);
			const account = await withTimeout$2(q.accountInfo(), timeoutMs).catch(() => void 0);
			return {
				at,
				...usage === null || usage === void 0 ? { error: "CLI 未返回额度信息" } : { usage },
				...account === void 0 ? {} : { account }
			};
		} finally {
			await q.close().catch(() => void 0);
		}
	}
};
//#endregion
//#region src/adapter.ts
/**
* `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
* through the qoder-agent-sdk. One warm inner session per host session id
* carries the conversation (model turns and tool rounds live inside it); host
* tool schemas are exposed to the inner model through an in-process MCP
* server whose handlers park until the host delivers tool results on the next
* request. Side-channel requests (titles, compaction) run cold one-shots.
* @module dsh-llm-qoder/adapter
*/
/** Shared empty values, so an unset list or map allocates nothing per read. */
const NO_MODELS$2 = [];
const NO_WINDOWS = {};
const NO_ALIASES$2 = {};
/** The primary provider route (the CN account's own models). */
const QODER_PROVIDER = "qoder-cn";
/** The international edition's route; a second adapter instance serves it. */
const QODER_INTL_PROVIDER = "qoder-intl";
/**
* Decide the context window to report for one live model.
*
* A per-model override wins when the user chose one; otherwise upstream's own
* `defaultContextWindow` is used, which is the window that model's session
* actually runs with. `maxInputTokens` is NOT a substitute — it is the ceiling
* for a single request and is often lower than the session window (e.g. 180 000
* against a 200 000 session), so falling back to it would understate capacity.
* Callers that accept a user override should validate it against
* `availableContextWindows` first — see {@link resolveDeclaredWindow}.
*
* @param live - the live catalog entry, when the CLI answered.
* @param override - the user's chosen window for this model, if any.
* @param fallback - window used when the catalog has nothing for this model.
* @returns the window in tokens.
*/
function pickContextWindow(live, override, fallback) {
	if (override !== void 0 && Number.isFinite(override) && override > 0) return override;
	if (live === void 0) return fallback;
	return live.defaultContextWindow ?? largestWindow(live.availableContextWindows) ?? live.maxInputTokens ?? fallback;
}
/** The largest window in a catalog entry's selectable list, or undefined. */
function largestWindow(available) {
	if (available === void 0 || available.length === 0) return void 0;
	return Math.max(...available);
}
/**
* The window the CLI will actually run this route with.
*
* Not the same thing as the window the harness is told about. A deployment may
* declare any window it likes — `modelContextWindows` accepts arbitrary numbers
* — but the CLI only honours one the model advertises in
* `availableContextWindows`; anything else it silently ignores and keeps its own
* default. Since the CLI measures `context_usage_ratio` against the window it is
* really using, this is the only correct multiplier for that ratio: using the
* declared window instead inflates every reading by
* `declared / actually-honoured` (5x for a 1M override on a 200K-only model).
*
* @param live - the live catalog entry, when the CLI answered.
* @param declared - the window this route publishes to the harness.
* @returns the window the CLI runs with, or undefined when unknown.
*/
function cliContextWindow(live, declared) {
	if (live === void 0) return void 0;
	const available = live.availableContextWindows;
	if (available !== void 0 && available.includes(declared)) return declared;
	return live.defaultContextWindow ?? largestWindow(available) ?? live.maxInputTokens;
}
/**
* The window to publish for one route, which is also the one the CLI is told
* to run with.
*
* A live entry is authoritative: the user's override counts only when the
* model advertises it. The CLI silently ignores anything else (a 1M choice on
* a 200K-only route), and dividing by it would understate every reading
* fivefold. When the catalog is momentarily unavailable, the last successful
* answer is reused instead of the static 200K default — that fallback used to
* change the denominator, and the compaction budget, mid-session: a 1M
* conversation read 1M one turn and 200K the next, and then compacted at what
* looked like 10%.
*/
function resolveDeclaredWindow(live, override, remembered, fallback) {
	if (live === void 0) return remembered ?? override ?? fallback;
	const available = live.availableContextWindows;
	return pickContextWindow(live, override !== void 0 && (available === void 0 || available.length === 0 || available.includes(override)) ? override : void 0, remembered ?? fallback);
}
function modelInfo$2(provider, entry) {
	return {
		provider,
		id: entry.id,
		name: entry.name,
		...entry.description === void 0 ? {} : { description: entry.description },
		inputModalities: entry.isVl === true ? ["text", "image"] : ["text"]
	};
}
/**
* Default selectable reasoning efforts for a Qoder model. The CLI catalog
* reports per-model `efforts`; this is the fallback when a model (or the
* static catalog) discloses none.
*/
const DEFAULT_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"max"
];
/** Human display name for the default effort ids. */
const EFFORT_NAMES = {
	low: "Low",
	medium: "Medium",
	high: "High",
	max: "Max"
};
/**
* Strength order used to pick a model's starting level.
*
* The three providers spell their levels differently (Qoder publishes
* `low|medium|high|max`, MiniMax `low|high`, CodeBuddy whatever its catalog
* declares), so the ranking is by name rather than by position in any one
* upstream list. An id outside this table ranks below every known one, which is
* what several sources agreeing on an unfamiliar spelling should do.
*/
const EFFORT_ORDER = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* The strongest level a model offers.
*
* Switching model or level must start at the most capable setting the route
* accepts, the same rule the sibling adapter plugin uses; the previous
* behaviour of following upstream's own default meant some models silently
* started one or two steps down (`CodeBuddy` advertises `high` as its default
* even when `max` is selectable).
*
* @param efforts - the levels the route accepts, in upstream order.
* @returns the strongest id, or undefined for a non-reasoning model.
*/
function strongestEffort(efforts) {
	if (efforts.length === 0) return void 0;
	let best;
	let bestRank = -1;
	for (const effort of efforts) {
		const rank = EFFORT_ORDER.indexOf(effort);
		if (best === void 0 || rank > bestRank) {
			best = effort;
			bestRank = rank;
		}
	}
	return best;
}
/**
* Build the `reasoning` metadata block for a resolved model, or undefined
* when the model does not support reasoning.
*
* The starting level is the strongest one the model accepts, not the level
* upstream happens to name as its default: the user's explicit choice in the
* sibling plugin, applied here too. An explicit configuration value still wins
* when the model accepts it.
*
* @param efforts - CLI-reported effort ids (absent for reasoning-less models).
* @param configuredEffort - user-configured starting level, when any.
* @param isReasoning - whether the model supports reasoning per the CLI.
* @returns the harness reasoning metadata, or undefined to omit it.
*/
function reasoningInfo(efforts, configuredEffort, isReasoning) {
	if (efforts === void 0 && isReasoning === false) return void 0;
	const ids = efforts !== void 0 && efforts.length > 0 ? efforts : DEFAULT_REASONING_EFFORTS;
	const defaultEffort = configuredEffort !== void 0 && ids.includes(configuredEffort) ? configuredEffort : strongestEffort(ids);
	return {
		efforts: ids.map((id) => ({
			id: ReasoningEffortId(id),
			name: EFFORT_NAMES[id] ?? id
		})),
		...defaultEffort === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }
	};
}
/**
* The Qoder-backed adapter. Session continuity, tool parking, and feed
* planning live here; chunk synthesis lives in the session's consumer.
*/
var QoderAdapter = class extends LlmAdapter {
	/**
	* The options as given, read where they are used rather than copied here.
	*
	* A `.volatile()` field is a live cell DSH updates in place, and such an edit
	* does not restart the plugin, so a value captured in the constructor would
	* stay frozen for the lifetime of the process (see `src/live.ts`).
	*/
	options;
	sessions;
	catalog;
	usage;
	readImage;
	imagePath;
	brand;
	/**
	* Memoized `Set` view of the disabled-model list.
	*
	* `updateVolatile` stores the freshly parsed array, so identity changes only
	* when the value does: caching on that identity keeps the per-model lookup a
	* hash probe instead of rebuilding a set per call, with no staleness.
	*/
	disabledCache;
	/**
	* The last window each route resolved to, plus what the model advertised.
	*
	* Reused only when a live entry is missing. Without it a failed refresh fell
	* back to the static 200K, so a 1M session suddenly declared 200K: the ring
	* denominator changed and the compaction engine budgeted against 200K,
	* compacting a history that was still only ~10% of the real window.
	*/
	knownWindows = /* @__PURE__ */ new Map();
	/**
	* Last verified image capability per route.
	*
	* A missed catalog refresh used to fall back to text-only, and DSH then
	* stripped the pixels before this adapter ran: a vision model silently lost
	* the image for that turn. Remembering the last answer keeps the declared
	* capability stable across a transient miss.
	*/
	knownVision = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		super();
		this.options = options;
		this.brand = options.brand ?? "cn";
		this.sessions = new QoderSessionManager(options.maxSessions ?? 8, {
			toolResultTimeoutMs: options.toolResultTimeoutMs,
			abortGraceMs: options.abortGraceMs,
			coldMaxTurns: options.coldMaxTurns,
			brand: this.brand
		});
		this.catalog = new QoderModelCatalog(this.brand, options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 2e4);
		this.usage = new QoderUsage(this.brand, options.usageCacheTtlMs);
		this.readImage = options.readImage;
		this.imagePath = options.imagePath;
	}
	get defaultMaxTokens() {
		return readLive(this.options.defaultMaxTokens, DEFAULT_MAX_TOKENS);
	}
	get modelContextWindows() {
		return readLive(this.options.modelContextWindows, NO_WINDOWS);
	}
	get disabledModels() {
		const source = readLive(this.options.disabledModels, NO_MODELS$2);
		const cached = this.disabledCache;
		if (cached !== void 0 && cached.source === source) return cached.set;
		const set = new Set(source);
		this.disabledCache = {
			source,
			set
		};
		return set;
	}
	get modelAliases() {
		return readLive(this.options.modelAliases, NO_ALIASES$2);
	}
	get defaultReasoningEffort() {
		return readLiveOptional(this.options.defaultReasoningEffort);
	}
	get displayName() {
		return readLive(this.options.displayName, brandProfile(this.brand).defaultDisplayName);
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.displayName
		};
	}
	/**
	* Whether one catalog entry is enabled for the picker.
	*
	* Only the user's off-switch is consulted: a model the account adds later
	* appears enabled by default, which a stored allow-list could not do.
	*/
	isVisible(id) {
		return !this.disabledModels.has(id);
	}
	/**
	* The user's chosen window for one catalog id, honouring aliases.
	*
	* A window may be stored under either the Qoder id or a harness-side alias,
	* so both spellings are checked before giving up.
	*/
	windowOverride(id) {
		const direct = this.modelContextWindows[id];
		if (direct !== void 0) return direct;
		for (const [key, value] of Object.entries(this.modelContextWindows)) if (resolveQoderModelId(key, this.modelAliases) === id) return value;
	}
	/**
	* The live catalog as the page renders it.
	*
	* Unlike {@link listModels}, this is not filtered by the user's on/off
	* choices: the page must show a switched-off model in order to switch it
	* back on.
	*
	* @returns live catalog entries in upstream order.
	*/
	async describeCatalog() {
		const live = await this.catalog.liveModels();
		for (const entry of live) {
			this.declaredWindow(entry.value, entry);
			this.knownVision.set(entry.value, entry.isVl === true);
		}
		return live;
	}
	/** Forget the cached catalog; the next read asks the CLI again. */
	invalidateCatalog() {
		this.catalog.invalidate();
	}
	/** Why the last catalog refresh failed, for the settings page's guidance. */
	catalogError() {
		return this.catalog.error;
	}
	/**
	* Read the account's quota and usage, as the Qoder clients display it.
	*
	* @param fresh - ignore the cached reading.
	*/
	async usageInfo(fresh = false) {
		return this.usage.read(fresh);
	}
	/** Forget the cached quota reading; the next read asks the CLI again. */
	invalidateUsage() {
		this.usage.invalidate();
	}
	/** Whether the user switched one model off. */
	isModelDisabled(id) {
		return this.disabledModels.has(id);
	}
	/** The stored disabled-model set, as a list for rewriting the field. */
	disabledModelIds() {
		return [...this.disabledModels];
	}
	/**
	* The user's window for one model, when the provider accepts it.
	*
	* A stored choice the model does not advertise is not a real choice: the CLI
	* ignores it and keeps its own window, so publishing it would only make the
	* meter divide by a capacity the route never runs with. Until the catalog
	* has answered once the choice is trusted (there is nothing to check yet).
	*/
	contextWindowFor(id) {
		const override = this.windowOverride(id);
		if (override === void 0) return void 0;
		const target = resolveQoderModelId(id, this.modelAliases);
		const available = this.knownWindows.get(target)?.available;
		if (available === void 0 || available.length === 0) return override;
		return available.includes(override) ? override : void 0;
	}
	/** The window this route publishes, remembering it for catalog misses. */
	declaredWindow(id, live) {
		const window = resolveDeclaredWindow(live, this.windowOverride(id), this.knownWindows.get(id)?.window, DEFAULT_CONTEXT_WINDOW);
		if (live !== void 0) this.knownWindows.set(id, {
			window,
			available: live.availableContextWindows
		});
		return window;
	}
	/** The stored per-model window map, for rewriting the field. */
	modelWindowChoices() {
		return this.modelContextWindows;
	}
	async listModels(provider) {
		return (await this.catalog.models()).filter((entry) => this.isVisible(entry.id)).map((entry) => modelInfo$2(provider, entry));
	}
	async resolveModel(provider, model, _signal) {
		const target = resolveQoderModelId(model, this.modelAliases);
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.liveModels())).find((entry) => entry.value === target);
		if (live !== void 0) {
			const vision = live.isVl === true;
			this.knownVision.set(target, vision);
			const reasoning = reasoningInfo(live.efforts, this.defaultReasoningEffort, live.isReasoning);
			return {
				provider,
				id: model,
				name: live.displayName.length > 0 ? live.displayName : live.value,
				...live.description.length > 0 ? { description: live.description } : {},
				inputModalities: vision ? ["text", "image"] : ["text"],
				context: { contextWindow: this.declaredWindow(target, live) },
				defaultMaxTokens: live.maxOutputTokens ?? this.defaultMaxTokens,
				...reasoning === void 0 ? {} : { reasoning }
			};
		}
		const configured = brandProfile(this.brand).staticCatalog ? QODER_MODELS.find((entry) => entry.id === target) : void 0;
		const reasoning = reasoningInfo(void 0, this.defaultReasoningEffort, true);
		const rememberedVision = this.knownVision.get(target) === true;
		return Promise.resolve({
			...configured === void 0 ? {
				provider,
				id: model,
				name: model
			} : {
				...modelInfo$2(provider, configured),
				id: model
			},
			inputModalities: rememberedVision ? ["text", "image"] : ["text"],
			context: { contextWindow: this.declaredWindow(target, void 0) },
			defaultMaxTokens: this.defaultMaxTokens,
			...reasoning === void 0 ? {} : { reasoning }
		});
	}
	/**
	* Bind one resolution generation to its dispatch, as the seam requires of a
	* dynamic adapter: the live catalog and the CLI login can change between the
	* harness preparing a call and the inner session running it, and a turn must
	* not mix one generation's declared capabilities with another's endpoint.
	*/
	async prepareCall(provider, model, signal) {
		const generation = await this.capture(provider, model, signal);
		return {
			model: generation.info,
			stream: (options) => this.dispatch(options, generation)
		};
	}
	async *stream(options) {
		yield* this.dispatch(options, await this.capture(options.provider, options.model, options.signal));
	}
	/** Resolve the exact route once and derive the capability facts from it. */
	async capture(provider, model, signal) {
		const info = await this.resolveModel(provider, model, signal);
		const target = resolveQoderModelId(model, this.modelAliases);
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.liveModels())).find((entry) => entry.value === target);
		const declared = info.context?.contextWindow;
		return {
			info,
			vision: info.inputModalities?.includes("image") === true,
			cliContextWindow: declared === void 0 ? void 0 : cliContextWindow(live, declared)
		};
	}
	async *dispatch(options, generation) {
		const model = resolveQoderModelId(options.model, this.modelAliases);
		if (options.sessionId === void 0 || options.purpose !== void 0) {
			const prompt = feedToText(renderInitialFeed(options.system, options.messages, this.imagePath), this.imagePath) + "\n（这是一次性旁路请求，直接输出下一条助手回复。）";
			yield* this.sessions.coldStream(options, prompt, model);
			return;
		}
		const sessionId = String(options.sessionId);
		const declaredWindow = generation.info.context?.contextWindow;
		const policy = {
			...options.reasoningEffort === void 0 ? {} : { reasoningEffort: options.reasoningEffort },
			...declaredWindow === void 0 ? {} : { contextWindow: declaredWindow },
			...generation.cliContextWindow === void 0 ? {} : { cliContextWindow: generation.cliContextWindow }
		};
		let session = this.sessions.forSession(sessionId, model);
		if (session.fedMessages === void 0) {
			yield* this.firstTurn(session, options, model, policy, generation.vision);
			return;
		}
		const tail = options.messages.slice(session.fedMessages.length);
		const images = await this.resolveTurnImages(tail, generation.vision, options.signal);
		session.deliverToolResults(tail, images);
		const plan = planContinuation(session.fedMessages, options.messages);
		if (plan.rebuild) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, model);
			yield* this.firstTurn(session, options, model, policy, generation.vision);
			return;
		}
		session.setModel(model, policy);
		session.ensureTools(options.tools ?? []);
		session.recordRequestInput(options.system, options.messages);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, generation.vision, images);
		yield* session.stream(options, feed, plan.feed === null ? void 0 : feedToText(plan.feed, this.imagePath));
	}
	async *firstTurn(session, options, model, policy, vision) {
		session.setModel(model, policy);
		session.setSystem(options.system);
		const cwd = options.cwd;
		session.setCwd(cwd);
		session.ensureTools(options.tools ?? []);
		session.recordRequestInput(options.system, options.messages);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const feed = renderInitialFeed(options.system, options.messages, this.imagePath);
		const images = await this.resolveImages(feedImageRefs(feed), vision, options.signal);
		yield* session.stream(options, await this.buildFeed(feed, vision, images), feedToText(feed, this.imagePath));
	}
	/** Image references carried by a message tail, skipping assistant content. */
	async resolveTurnImages(tail, vision, signal) {
		const refs = tail.flatMap((message) => message.role === "assistant" ? [] : imageRefs(message.content));
		return this.resolveImages(refs, vision, signal);
	}
	/** Resolve image references into base64 request bytes; absent reader → none. */
	async resolveImages(refs, vision, signal) {
		const map = /* @__PURE__ */ new Map();
		if (!vision || this.readImage === void 0 || refs.length === 0) return map;
		for (const ref of refs) {
			const key = String(ref.attachmentId);
			if (map.has(key)) continue;
			try {
				const image = await this.readImage(ref, signal);
				if (image !== void 0) map.set(key, {
					data: Buffer.from(image.bytes).toString("base64"),
					mediaType: image.mediaType
				});
			} catch {}
		}
		return map;
	}
	/**
	* Turn a feed into channel content. A text feed passes through; a non-vision
	* feed flattens to the harness's own image handle text; an image the host
	* could not read keeps a note naming what was dropped, so the inner model
	* still knows the attachment was there.
	*/
	async buildFeed(feed, vision, images) {
		if (typeof feed === "string") return feed;
		if (!vision) return feedToText(feed, this.imagePath);
		const content = [];
		let pixels = 0;
		for (const part of feed) {
			if (part.type === "text") {
				if (part.text.length > 0) content.push({
					type: "text",
					text: part.text
				});
				continue;
			}
			const key = String(part.attachment.attachmentId);
			const resolved = images.get(key);
			const path = this.imagePath?.(part.attachment);
			if (resolved === void 0) {
				content.push({
					type: "text",
					text: `[图片附件 ${key} 本次未能读取${path === void 0 ? "" : `；本机文件：${path}`}，请基于文字内容继续]`
				});
				continue;
			}
			content.push({
				type: "text",
				text: imageRefText(part.attachment, path)
			});
			pixels += 1;
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: resolved.mediaType,
					data: resolved.data
				}
			});
		}
		return pixels === 0 ? content.map((block) => block.type === "text" ? block.text : "").join("\n\n") : content;
	}
	/**
	* Drop every warm inner session without unloading the plugin.
	*
	* Signing out has to invalidate them: each holds a CLI process that already
	* loaded its credentials, so it would keep answering as the account that was
	* just signed out. The next turn starts a fresh process, which then reports
	* the signed-out state honestly.
	*/
	closeSessions() {
		this.sessions.closeAll();
	}
	/** Tear down every warm inner session (plugin dispose). */
	close() {
		this.sessions.closeAll();
	}
};
/**
* Decide what to feed on a continuation request. The previous list must be a
* prefix (same length growth, index 0 untouched, at most two in-place
* mutations — the host refreshes runtime-context snapshots in place every
* turn). Tail tool-result messages were already resolved into parked handlers
* and never feed; fresh user turns and mutated messages do.
*/
function planContinuation(previous, current) {
	if (current.length <= previous.length) return {
		feed: null,
		rebuild: true
	};
	const mutated = [];
	for (let i = 0; i < previous.length; i++) if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i);
	if (mutated.includes(0) || mutated.length > 2) return {
		feed: null,
		rebuild: true
	};
	const freshUser = current.slice(previous.length).filter((m) => m.role === "user");
	if (freshUser.length === 0 && mutated.length === 0) return {
		feed: null,
		rebuild: false
	};
	const parts = [];
	for (const index of mutated) {
		const message = current[index];
		if (message !== void 0) parts.push(renderRefreshed(message));
	}
	for (const message of freshUser) parts.push(renderUserTurn(message.content));
	const feed = joinFeeds(parts);
	return {
		feed: typeof feed === "string" && feed.length === 0 ? null : feed,
		rebuild: false
	};
}
//#endregion
//#region src/codebuddy-state.ts
/**
* CodeBuddy's own per-region snapshot on disk.
*
* The SDK's browser login returns a bearer token, but it is only available in
* the process that ran the login. Saving it here is what lets a later process
* switch back to a region and use the account immediately instead of opening
* the browser again. The account and quota reading are saved alongside it so
* the settings card can paint before a fresh CLI read finishes.
*
* The file is per-user, mode 0600, and contains a bearer credential: do not log
* it or copy it into bug reports.
*
* @module dsh-agent-sdk-bridge/codebuddy-state
*/
/**
* A stored account reading with its credential removed.
*
* The CLI's `accountInfo()` answer carries a bearer token, and older versions
* persisted that object whole — a second copy of the credential in a file that
* gets backed up and pasted into bug reports, one the plugin never read. A
* region holds exactly one credential, in `token`.
*/
function withoutCredential(account) {
	if (account === void 0) return void 0;
	const clean = {};
	for (const [key, value] of Object.entries(account)) {
		if (/token|secret|credential|password|cookie/i.test(key)) continue;
		clean[key] = value;
	}
	return clean;
}
/**
* The default file path.
*
* `DSH_HOME` is honoured so a desktop profile and a web profile keep separate
* credentials; `DSH_CODUBUDDY_STATE_PATH` exists for tests and power users.
*/
function defaultPath() {
	const override = process.env.DSH_CODUBUDDY_STATE_PATH;
	if (override !== void 0 && override.length > 0) return override;
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "agent-sdk-bridge", "codebuddy-state.json");
}
/**
* One CLI user-data directory per login region.
*
* The bundled CLI remembers its product environment inside this directory and
* only switches it during initialize, after the model provider has already
* chosen a catalog. Two regions sharing the default `~/.codebuddy` therefore
* read each other's catalogs after a switch, and the wrong list got cached for
* five minutes. A separate directory fixes the environment per region, so every
* boot reads its own catalog. `DSH_CODUBUDDY_CLI_DIR` exists for tests.
*/
function codeBuddyCliDir(region) {
	const override = process.env.DSH_CODUBUDDY_CLI_DIR;
	const root = override !== void 0 && override.length > 0 ? override : join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "agent-sdk-bridge", "codebuddy-cli");
	const dir = join(root, region);
	mkdirSync(dir, { recursive: true });
	return dir;
}
/** The per-user file behind {@link CodeBuddyStateStore}. */
var CodeBuddyStateStore = class {
	file;
	loaded = false;
	state = {
		version: 1,
		regions: {}
	};
	constructor(file = defaultPath()) {
		this.file = file;
	}
	ensureLoaded() {
		if (this.loaded) return this.state;
		this.loaded = true;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			if (parsed.version === 1 && parsed.regions !== null && typeof parsed.regions === "object") {
				this.state = {
					version: 1,
					regions: parsed.regions
				};
				this.recoverLostTokens();
			}
		} catch {}
		return this.state;
	}
	/**
	* Lift a credential the old layout hid inside the account object.
	*
	* The CLI's `accountInfo()` answer carries a bearer token of its own, and an
	* earlier version persisted that whole object here. When the top-level
	* `token` was later dropped — which any quota failure used to do, because
	* expiry was *guessed* from the error text — the region read as signed out
	* even though a working credential still sat in the file, and nothing could
	* recover it without a fresh browser login. This picks the copy back up.
	*
	* {@link persist} no longer stores a token inside the account, so this runs
	* only over files written by those older versions.
	*/
	recoverLostTokens() {
		let recovered = false;
		for (const [key, saved] of Object.entries(this.state.regions)) {
			const region = key;
			const hidden = (saved?.account)?.token;
			if (saved === void 0 || saved.token !== void 0) continue;
			if (typeof hidden !== "string" || hidden.length === 0) continue;
			this.state.regions[region] = {
				...saved,
				token: hidden,
				signedIn: true,
				account: withoutCredential(saved.account)
			};
			recovered = true;
		}
		if (recovered) this.persist();
	}
	region(region) {
		return this.ensureLoaded().regions[region];
	}
	/** The stored bearer token, or undefined when the region is signed out. */
	token(region) {
		const token = this.region(region)?.token;
		return typeof token === "string" && token.length > 0 ? token : void 0;
	}
	user(region) {
		return this.region(region)?.user;
	}
	signedIn(region) {
		return this.region(region)?.signedIn === true;
	}
	/** The saved account reading, in the shape the usage route returns. */
	usage(region) {
		const saved = this.region(region);
		if (saved === void 0 || saved.at === void 0 || saved.signedIn !== true) return void 0;
		return {
			at: saved.at,
			...saved.account === void 0 ? {} : { account: saved.account },
			...saved.quota === void 0 ? {} : { quota: saved.quota },
			...saved.quotaError === void 0 ? {} : { quotaError: saved.quotaError }
		};
	}
	/** Merge fields into one region and write the file; `undefined` deletes. */
	patch(region, patch) {
		const state = this.ensureLoaded();
		const next = { ...state.regions[region] };
		for (const [key, value] of Object.entries(patch)) if (value === void 0) delete next[key];
		else next[key] = value;
		if (next.account !== void 0) next.account = withoutCredential(next.account);
		state.regions[region] = next;
		this.persist();
	}
	/**
	* Drop only the credential, keeping the last account reading.
	*
	* An expired token must stop being used for sessions, while the card can
	* still show which account expired so the user knows what to sign into.
	*/
	clearToken(region) {
		const saved = this.ensureLoaded().regions[region];
		if (saved === void 0) return;
		delete saved.token;
		saved.signedIn = false;
		this.persist();
	}
	/** Forget one region entirely: logout and expired credentials both land here. */
	clear(region) {
		const state = this.ensureLoaded();
		delete state.regions[region];
		this.persist();
	}
	persist() {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const temporary = `${this.file}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 384 });
			try {
				chmodSync(temporary, 384);
			} catch {}
			renameSync(temporary, this.file);
		} catch {}
	}
};
//#endregion
//#region src/codebuddy.ts
/**
* CodeBuddy's account, catalog, login and warm sessions.
*
* The SDK is the CodeBuddy Code SDK (`@tencent-ai/agent-sdk`). It bundles its
* own CLI, so unlike the Qoder brands there is no global install and no batch
* helper: login is an SDK call whose region is `external` (international) or
* `internal` (mainland). Enterprise/IOA/self-hosted login is out of scope.
*
* One CodeBuddy provider serves both regions; the region is a setting, so the
* models and account shown always belong to the selected login.
*
* @module dsh-agent-sdk-bridge/codebuddy
*/
/**
* Literal characters in a channel payload; images contribute pixels, not text.
*
* The per-turn input estimate charges text only, matching how the Qoder path
* counts a feed, so a picture cannot inflate the reported prompt size.
*/
function contentChars(content) {
	return content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}
/**
* Wrap one turn's content the way the SDK's `send()` expects it.
*
* A plain string keeps the historical shape; image turns are wrapped in a
* `UserMessage`, because a bare `ContentBlock[]` is not accepted and dropping
* the wrapper silently loses the picture.
*/
function toCodeBuddyUserMessage(sessionId, content) {
	if (typeof content === "string") return content;
	return {
		type: "user",
		session_id: sessionId,
		message: {
			role: "user",
			content
		},
		parent_tool_use_id: null
	};
}
/** Default context capacity assumed for a CodeBuddy model that declares none. */
const CODEBUDDY_DEFAULT_CONTEXT_WINDOW = 2e5;
/** Default output cap when the catalog declares none. */
const CODEBUDDY_DEFAULT_MAX_TOKENS = 32e3;
/** How long one CodeBuddy account/catalog read stays fresh. */
const CODEBUDDY_CACHE_TTL_MS = 3e5;
/** Give up on one CodeBuddy control round trip after this long. */
const CODEBUDDY_FETCH_TIMEOUT_MS = 3e4;
/** How long a login waits for the browser before giving up. */
const LOGIN_TIMEOUT_MS = 3e5;
/** Bound for clearing stale credentials before a fresh browser login. */
const LOGOUT_TIMEOUT_MS = 2e4;
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/**
* The same namespace after the CLI normalises the server name.
*
* CodeBuddy rewrites every non-alphanumeric character in an MCP server name to
* `_`, so a server registered as `dsh-host` is exposed to the model as
* `mcp__dsh_host__<tool>`. Matching only the registered spelling rejected the
* host's own tools as "built-ins", which is exactly why the model fell back to
* `Bash`. The Qoder CLI keeps the hyphen, so both spellings are accepted.
*/
const MCP_TOOL_PREFIX_SANITIZED = `mcp__${MCP_SERVER_NAME.replace(/[^a-zA-Z0-9]/g, "_")}__`;
/** Whether a CLI tool name belongs to this plugin's MCP server. */
function isHostTool(toolName) {
	return toolName.startsWith(MCP_TOOL_PREFIX) || toolName.startsWith(MCP_TOOL_PREFIX_SANITIZED);
}
/** The host-side tool name, with the MCP namespace removed. */
function hostToolName(toolName) {
	if (toolName.startsWith(MCP_TOOL_PREFIX)) return toolName.slice(MCP_TOOL_PREFIX.length);
	if (toolName.startsWith(MCP_TOOL_PREFIX_SANITIZED)) return toolName.slice(MCP_TOOL_PREFIX_SANITIZED.length);
	return toolName;
}
/**
* Whether the CLI answered as the anonymous fallback.
*
* With an invalid `CODEBUDDY_AUTH_TOKEN` the CLI still reports an account
* object whose uid is `anonymous`; treating that as a login would show a
* signed-in card and try the quota endpoint with a dead credential.
*/
function isUnauthenticatedAccount(account) {
	return Object.keys(account).length === 0 || (account.uid ?? account.userId) === "anonymous";
}
/** The public billing hosts; both regions speak the same quota protocol. */
const CODEBUDDY_ENDPOINTS = {
	global: "https://www.codebuddy.ai",
	cn: "https://copilot.tencent.com"
};
const QUOTA_PATH = "/v2/billing/meter/get-user-resource";
const QUOTA_RANGE_END = "2099-12-31 23:59:59";
/** Cosmetic fingerprint headers the upstream checks; kept in step with the CLI. */
const CLIENT_VERSION = "2.174.0";
/** Tokens obtained from a successful login or a silent auth read, per region. */
const bearerTokens = /* @__PURE__ */ new Map();
/** Persisted per-region login and account snapshots. */
const codeBuddyState = new CodeBuddyStateStore();
/** The region's bearer token, falling back to the persisted copy. */
function tokenFor(region) {
	const cached = bearerTokens.get(region);
	if (cached !== void 0) return cached;
	const saved = codeBuddyState.token(region);
	if (saved !== void 0) bearerTokens.set(region, saved);
	return saved;
}
/**
* The child-process environment for one region's CLI.
*
* Two things ride here:
*
* - `CODEBUDDY_AUTH_TOKEN`, so a saved login works without another browser
*   round trip.
* - `CODEBUDDY_CONFIG_DIR`, a directory of this region's own. The CLI stores
*   its product environment inside that directory and only switches it during
*   initialize, while its model provider has already chosen a catalog. With a
*   shared directory, switching regions read the other region's catalog and
*   cached it, which made the model list — and the enabled/disabled choices
*   derived from it — belong to the wrong region. One directory per region
*   pins the environment, so a fresh process always reads the right catalog.
*/
function cliEnv(region) {
	const env = cliDirEnv(region);
	const token = tokenFor(region);
	if (token !== void 0) env.CODEBUDDY_AUTH_TOKEN = token;
	return { env };
}
/**
* The region's own CLI directory, with no credential attached.
*
* The login, logout and silent-token calls need this and nothing else: they
* must not carry a bearer token (login starts fresh, logout clears), but they
* absolutely must be scoped to one region. Without it they acted on the CLI's
* default `~/.codebuddy`, which both regions share — so signing in for one
* region overwrote the other's login, and `logout` for the region the page was
* showing left the credential of the other one standing.
*/
function cliDirEnv(region) {
	return { CODEBUDDY_CONFIG_DIR: codeBuddyCliDir(region) };
}
/** Remember a bearer token in memory and on disk. */
function rememberBearerToken(region, token, user) {
	if (token.length === 0) return;
	bearerTokens.set(region, token);
	codeBuddyState.patch(region, {
		token,
		signedIn: true,
		...user === void 0 ? {} : { user }
	});
}
/** Stop using a credential without losing the remembered account card. */
function forgetToken(region) {
	bearerTokens.delete(region);
	codeBuddyState.clearToken(region);
}
/** Parse the catalog's `x0.79 credits` string into a number. */
function priceFactorOf$1(model) {
	const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(model.credits ?? "");
	if (match === null) return void 0;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : void 0;
}
/** Turn one raw catalog entry into the model row this plugin uses. */
function toCodeBuddyModel(model) {
	const windows = new Set(model.contextWindow?.supportedLengths ?? []);
	const declared = model.contextWindow?.defaultLength ?? model.maxInputTokens ?? model.maxAllowedSize ?? 2e5;
	return {
		id: model.id,
		name: model.name ?? model.id,
		...(model.description ?? model.descriptionZh ?? model.descriptionEn) === void 0 ? {} : { description: model.description ?? model.descriptionZh ?? model.descriptionEn },
		...model.maxInputTokens === void 0 ? {} : { maxInputTokens: model.maxInputTokens },
		...model.maxOutputTokens === void 0 ? {} : { maxOutputTokens: model.maxOutputTokens },
		contextWindows: [...windows].sort((a, b) => a - b),
		defaultContextWindow: declared,
		vision: model.supportsImages === true && model.disabledMultimodal !== true,
		...model.reasoning?.supportedEfforts === void 0 ? model.supportsReasoning === true ? { reasoningEfforts: [
			"low",
			"medium",
			"high"
		] } : {} : { reasoningEfforts: [...model.reasoning.supportedEfforts] },
		...model.reasoning?.defaultEffort === void 0 ? {} : { defaultEffort: model.reasoning.defaultEffort },
		...priceFactorOf$1(model) === void 0 ? {} : { priceFactor: priceFactorOf$1(model) }
	};
}
/** Run one short-lived session and hand it to `run`, always closing it. */
async function withSession(region, run, timeoutMs, options = {}) {
	const session = (await loadCodeBuddySdk()).unstable_v2_createSession({
		environment: codeBuddyEnvironment(region),
		sessionId: options.sessionId ?? randomUUID(),
		...options.model === void 0 ? {} : { model: options.model },
		...options.systemPrompt === void 0 ? {} : { systemPrompt: options.systemPrompt },
		...cliEnv(region),
		settingSources: [],
		persistSession: false
	});
	try {
		await withTimeout$1(session.connect(), timeoutMs);
		return await withTimeout$1(run(session), timeoutMs);
	} finally {
		session.close();
	}
}
function withTimeout$1(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`CodeBuddy request timed out after ${ms}ms`));
		}, ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
/**
* The account's model catalog for one region.
*
* CodeBuddy only answers this after the CLI has started, so the read costs one
* process boot. Results are cached per region and fall back to the last good
* list when a refresh fails.
*/
var CodeBuddyCatalog = class {
	region;
	ttlMs;
	timeoutMs;
	snapshots = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	constructor(region, ttlMs = CODEBUDDY_CACHE_TTL_MS, timeoutMs = CODEBUDDY_FETCH_TIMEOUT_MS) {
		this.region = region;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/**
	* The last catalog read for a region, without fetching.
	*
	* Callers that must answer synchronously (deciding whether a model exposes a
	* context-budget choice) use this instead of awaiting a refresh.
	*/
	snapshot(requested) {
		return this.snapshots.get(requested ?? readLive(this.region, "global"))?.models;
	}
	/** Models for one region; a failed refresh keeps the last good list. */
	async models(requested) {
		const region = requested ?? readLive(this.region, "global");
		const ttl = readLive(this.ttlMs, CODEBUDDY_CACHE_TTL_MS);
		const cached = this.snapshots.get(region);
		if (cached !== void 0 && Date.now() - cached.at < ttl) return cached.models;
		let pending = this.inflight.get(region);
		if (pending === void 0) {
			pending = this.fetch(region).finally(() => {
				this.inflight.delete(region);
			});
			this.inflight.set(region, pending);
		}
		try {
			const models = await pending;
			this.snapshots.set(region, {
				at: Date.now(),
				models
			});
			this.failures.delete(region);
			return models;
		} catch (error) {
			this.failures.set(region, error instanceof Error ? error.message : String(error));
			return cached?.models ?? [];
		}
	}
	/** Why the last refresh failed, or undefined when it succeeded. */
	error(requested) {
		return this.failures.get(requested ?? readLive(this.region, "global"));
	}
	invalidate(region) {
		if (region === void 0) {
			this.snapshots.clear();
			this.failures.clear();
			return;
		}
		this.snapshots.delete(region);
		this.failures.delete(region);
	}
	async fetch(region) {
		return await withSession(region, async (session) => {
			return (await session.getAvailableModelsRaw()).map(toCodeBuddyModel);
		}, readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS));
	}
};
/** Read the signed-in account once per TTL. */
var CodeBuddyAccountReader = class {
	region;
	ttlMs;
	timeoutMs;
	cached = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	constructor(region, ttlMs = CODEBUDDY_CACHE_TTL_MS, timeoutMs = CODEBUDDY_FETCH_TIMEOUT_MS) {
		this.region = region;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/**
	* The account for one region.
	*
	* A non-fresh read answers from the persisted snapshot first, so switching
	* the region selector paints immediately; the page follows with `fresh=1`
	* to replace it with a live CLI reading.
	*/
	async read(fresh = false, requested) {
		const region = requested ?? readLive(this.region, "global");
		if (!fresh) {
			const memory = this.cached.get(region);
			if (memory !== void 0) return memory;
			const saved = codeBuddyState.usage(region);
			if (saved !== void 0) {
				this.cached.set(region, saved);
				return saved;
			}
		}
		let pending = this.inflight.get(region);
		if (pending === void 0) {
			pending = this.fetch(region).finally(() => {
				this.inflight.delete(region);
			});
			this.inflight.set(region, pending);
		}
		const snapshot = await pending;
		this.cached.set(region, snapshot);
		return snapshot;
	}
	invalidate(region) {
		if (region === void 0) this.cached.clear();
		else this.cached.delete(region);
	}
	async fetch(region) {
		const at = Date.now();
		try {
			const account = await readAccount(region, readLive(this.timeoutMs, CODEBUDDY_FETCH_TIMEOUT_MS));
			if (isUnauthenticatedAccount(account)) {
				forgetToken(region);
				codeBuddyState.patch(region, {
					signedIn: false,
					account: void 0,
					quota: void 0,
					quotaError: void 0,
					at
				});
				return {
					at,
					error: `${region === "cn" ? "CodeBuddy 国内版" : "CodeBuddy 国际版"}尚未登录，请在页面顶部选择该区域并登录。`
				};
			}
			codeBuddyState.patch(region, {
				signedIn: true,
				account,
				at
			});
			try {
				const quota = await readQuotaWithToken(region);
				codeBuddyState.patch(region, {
					quota,
					quotaError: void 0,
					at
				});
				return {
					at,
					account,
					quota
				};
			} catch (quotaError) {
				const message = quotaError instanceof Error ? quotaError.message : String(quotaError);
				if (isCredentialRejected(quotaError)) forgetToken(region);
				else codeBuddyState.patch(region, {
					quota: void 0,
					quotaError: message
				});
				return {
					at,
					account,
					quotaError: message
				};
			}
		} catch (error) {
			return {
				at,
				error: authErrorText(region, error)
			};
		}
	}
};
/**
* Read the signed-in account through a one-shot query.
*
* `createSession` exposes models but not the account, while `query()` exposes
* `accountInfo()`; the prompt never yields, so no model turn is started.
*/
async function readAccount(region, timeoutMs) {
	const q = (await loadCodeBuddySdk()).query({
		prompt: inertInput(),
		options: {
			environment: codeBuddyEnvironment(region),
			...cliEnv(region),
			tools: [],
			settingSources: [],
			maxTurns: 1
		}
	});
	try {
		await withTimeout$1(q.connect(), timeoutMs);
		return withoutCredential(await withTimeout$1(q.accountInfo(), timeoutMs)) ?? {};
	} finally {
		await q.return().catch(() => void 0);
	}
}
/** Streaming prompt that never yields, so no model turn runs. */
async function* inertInput() {
	await new Promise(() => {});
}
/** Turn a raw SDK failure into a sentence the settings page can act on. */
function authErrorText(region, error) {
	const detail = error instanceof Error ? error.message : String(error);
	const label = region === "cn" ? "CodeBuddy 国内版" : "CodeBuddy 国际版";
	if (/auth|login|登录|credential|401|unauthor/i.test(detail)) return `${label}尚未登录，请在页面顶部选择该区域并登录。`;
	return detail;
}
/**
* The account's credits, read from CodeBuddy's billing endpoint.
*
* The SDK exposes no quota call, but the CLI's own account page uses
* `POST /v2/billing/meter/get-user-resource` on the same host. The response is
* a list of independently expiring credit packages; `CycleCapacity*Precise`
* is the live balance, while the top-level `TotalDosage` is a stale
* period-scoped figure and is deliberately ignored.
*
* @param payload - the endpoint's JSON answer.
*/
function parseCodeBuddyQuota(payload) {
	const data = payload?.data;
	if (data === null || data === void 0 || typeof data !== "object") throw new Error("额度响应缺少 data");
	const response = data.Response;
	const error = response?.Error;
	if (error?.Code !== void 0 && error.Code !== 0 && error.Code !== "0") throw new Error(`${String(error.Code)}: ${String(error.Message ?? "")}`);
	const source = (response?.Data)?.Accounts ?? response?.Accounts ?? data.Data?.Accounts ?? data.Accounts;
	if (!Array.isArray(source)) throw new Error("额度响应缺少 Accounts");
	const now = Date.now();
	let total = 0;
	let remaining = 0;
	let cycleEnd;
	const packages = [];
	for (const entry of source) {
		if (entry === null || typeof entry !== "object") continue;
		if (Number(entry.Status) !== 0) continue;
		const packageTotal = cycleCapacity(entry, "CycleCapacitySize");
		if (packageTotal <= 0) continue;
		const packageRemaining = Math.max(0, cycleCapacity(entry, "CycleCapacityRemain"));
		total += packageTotal;
		remaining += packageRemaining;
		const end = parseLocalTime(entry.CycleEndTime);
		if (packageRemaining > 0 || end !== void 0 && end > now) packages.push({
			name: String(entry.PackageName ?? ""),
			total: packageTotal,
			used: Math.max(0, packageTotal - packageRemaining),
			...end === void 0 ? {} : { end }
		});
		if (end !== void 0 && end > now && packageRemaining > 0) cycleEnd = cycleEnd === void 0 ? end : Math.min(cycleEnd, end);
	}
	return {
		remaining,
		total,
		used: Math.max(0, total - remaining),
		...cycleEnd === void 0 ? {} : { cycleEnd },
		packages
	};
}
function numeric(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function cycleCapacity(entry, key) {
	return numeric(entry[`${key}Precise`]) ?? numeric(entry[key]) ?? 0;
}
function parseLocalTime(value) {
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const parsed = Date.parse(value.trim().replace(" ", "T"));
	return Number.isFinite(parsed) ? parsed : void 0;
}
function formatLocalTime(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
/**
* A bearer token for the region, from a recent login or a silent SDK read.
*
* The silent read is the documented behaviour of `authenticate` — return the
* CLI's existing token instead of opening a browser when the region is signed
* in — but it did not work as measured: on a machine with a live CodeBuddy
* login it timed out for both regions, each in the shared default directory and
* in both per-region directories. So treat it as best effort, and never as a
* place to recover from: the copy this plugin saved is the only credential a
* session can count on, which is why dropping it used to read as "not signed
* in" even while the account still worked.
*/
async function readBearerToken(region) {
	const cached = tokenFor(region);
	if (cached !== void 0) return cached;
	const result = await withTimeout$1((await loadCodeBuddySdk()).unstable_v2_authenticate({
		environment: codeBuddyEnvironment(region),
		env: cliDirEnv(region),
		timeout: 3e3,
		onAuthUrl: () => {}
	}), 6e3);
	rememberBearerToken(region, result.userinfo.token, {
		userId: result.userinfo.userId,
		userName: result.userinfo.userName,
		userNickname: result.userinfo.userNickname
	});
	return result.userinfo.token;
}
/** Query the billing endpoint once. */
async function fetchCodeBuddyQuota(region, token, fetchImpl = fetch) {
	const endpoint = CODEBUDDY_ENDPOINTS[region];
	const host = new URL(endpoint).host;
	const body = {
		PageNumber: 1,
		PageSize: 200,
		Status: [0, 3],
		PackageEndTimeRangeBegin: formatLocalTime(/* @__PURE__ */ new Date()),
		PackageEndTimeRangeEnd: QUOTA_RANGE_END
	};
	const response = await fetchImpl(`${endpoint}${QUOTA_PATH}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json",
			"x-requested-with": "XMLHttpRequest",
			"x-stainless-arch": process.arch === "arm64" ? "arm64" : "x64",
			"x-stainless-lang": "js",
			"x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
			"x-stainless-package-version": "6.25.0",
			"x-stainless-retry-count": "0",
			"x-stainless-runtime": "node",
			"x-stainless-runtime-version": process.version,
			"x-conversation-id": randomUUID(),
			"x-conversation-request-id": randomBytes(16).toString("hex"),
			"x-conversation-message-id": randomUUID().replace(/-/g, ""),
			"x-request-id": randomUUID().replace(/-/g, ""),
			"x-agent-intent": "craft",
			"x-agent-purpose": "conversation",
			"x-ide-type": "CLI",
			"x-ide-name": "CLI",
			"x-ide-version": CLIENT_VERSION,
			"user-agent": `CLI/${CLIENT_VERSION} CodeBuddy/${CLIENT_VERSION}`,
			"x-private-data": "false",
			"x-codebuddy-request": "1",
			"x-product": "SaaS",
			"x-domain": host
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15e3)
	});
	const text = await response.text();
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) throw new CredentialRejectedError("CodeBuddy 登录已过期，请重新登录");
		const detail = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
		throw new Error(`CodeBuddy 额度接口返回 HTTP ${response.status}${detail === "" ? "" : `：${detail}`}`);
	}
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("CodeBuddy 额度接口返回了非 JSON 内容");
	}
	return parseCodeBuddyQuota(payload);
}
/**
* The credential this region holds was rejected by the endpoint.
*
* Thrown where the rejection is *known* — an explicit HTTP 401/403 — rather
* than inferred from the error text. Inferring it was the bug: the loose
* matcher below used to treat any failure whose message happened to contain
* "token", "401" inside a number, or an HTML body mentioning a token, as an
* expired login. It then dropped a working credential, and because a missing
* local token reads as "signed out", the page showed an account as not signed
* in while the CLI still had a usable login.
*/
var CredentialRejectedError = class extends Error {};
/**
* Whether a quota failure genuinely means the credential no longer works.
*
* The typed error carries the CLI's own expiry sentence, which is also matched
* here because the message is ours, fixed, and not derived from server text.
* Everything else — a 5xx, a bad payload, a timeout, an unreachable endpoint —
* leaves the credential alone.
*
* @param error - whatever quota reading threw.
*/
function isCredentialRejected(error) {
	if (error instanceof CredentialRejectedError) return true;
	return (error instanceof Error ? error.message : String(error)) === "CodeBuddy 登录已过期，请重新登录";
}
/** Read quota, retrying once with a fresh token after an auth failure. */
async function readQuotaWithToken(region) {
	const token = await readBearerToken(region).catch((error) => {
		throw new Error(authErrorText(region, error));
	});
	try {
		return await fetchCodeBuddyQuota(region, token);
	} catch (error) {
		if (!isCredentialRejected(error)) throw error;
		forgetToken(region);
		return await fetchCodeBuddyQuota(region, await readBearerToken(region).catch((renewError) => {
			throw new Error(authErrorText(region, renewError));
		}));
	}
}
/**
* Browser login/logout per region.
*
* The SDK owns the browser flow: it emits a URL, waits for the CLI to report
* the result, and stores the credential where the CLI reads it. This manager
* only remembers progress so the settings page can poll it.
*/
var CodeBuddyAuth = class {
	runs = /* @__PURE__ */ new Map();
	/** Start a login; refuses while the same region is already logging in. */
	start(region, onFinish) {
		if (this.runs.get(region)?.status.running === true) return {
			started: false,
			error: "该区域正在登录，请先在浏览器中完成。"
		};
		bearerTokens.delete(region);
		codeBuddyState.clear(region);
		const run = { status: {
			running: true,
			region,
			startedAt: Date.now(),
			signedIn: false
		} };
		this.runs.set(region, run);
		this.login(run, onFinish);
		return { started: true };
	}
	status(region) {
		const run = this.runs.get(region);
		if (run !== void 0) return run.status;
		const saved = codeBuddyState.region(region);
		return {
			running: false,
			region,
			signedIn: saved?.signedIn === true,
			...saved?.user === void 0 ? {} : { user: saved.user }
		};
	}
	/** Clear the cached credential for one region. */
	async logout(region) {
		let failure;
		try {
			await withTimeout$1((await loadCodeBuddySdk()).unstable_v2_logout({
				environment: codeBuddyEnvironment(region),
				env: cliDirEnv(region)
			}), CODEBUDDY_FETCH_TIMEOUT_MS);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		this.runs.delete(region);
		bearerTokens.delete(region);
		codeBuddyState.clear(region);
		return failure === void 0 ? { ok: true } : {
			ok: false,
			error: failure
		};
	}
	/** False once this run was replaced or cancelled by logout. */
	current(run) {
		return this.runs.get(run.status.region) === run;
	}
	async login(run, onFinish) {
		const { status } = run;
		const { region } = status;
		try {
			const sdk = await loadCodeBuddySdk();
			await withTimeout$1(sdk.unstable_v2_logout({
				environment: codeBuddyEnvironment(region),
				env: cliDirEnv(region)
			}), LOGOUT_TIMEOUT_MS).catch(() => void 0);
			if (!this.current(run)) return;
			bearerTokens.delete(region);
			const result = await sdk.unstable_v2_authenticate({
				environment: codeBuddyEnvironment(region),
				env: cliDirEnv(region),
				timeout: LOGIN_TIMEOUT_MS,
				onAuthUrl: (state) => {
					status.url = state.authUrl;
				}
			});
			if (!this.current(run)) return;
			status.running = false;
			status.finishedAt = Date.now();
			const user = {
				userId: result.userinfo.userId,
				userName: result.userinfo.userName,
				userNickname: result.userinfo.userNickname
			};
			status.user = user;
			status.signedIn = true;
			rememberBearerToken(region, result.userinfo.token, user);
			onFinish?.(true);
		} catch (error) {
			if (!this.current(run)) return;
			status.running = false;
			status.finishedAt = Date.now();
			status.signedIn = false;
			status.error = authErrorText(region, error);
			onFinish?.(false);
		}
	}
};
/** A token count as a non-negative whole number; anything unusable becomes 0. */
function countOf(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}
/** Whether one usage frame actually measured a prompt. */
function measuredPrompt(usage) {
	return usage !== void 0 && (countOf(usage.input_tokens) > 0 || countOf(usage.cache_read_input_tokens) > 0 || countOf(usage.cache_creation_input_tokens) > 0);
}
/**
* Fold one `message_delta` usage into the turn's reading.
*
* The delta is cumulative for its own message and carries the final output
* count. Not every transport repeats the prompt fields on it, so the last
* measured values are kept rather than letting a later frame erase them.
*/
function mergeTurnUsage(previous, next) {
	const output = typeof next.output_tokens === "number" && Number.isFinite(next.output_tokens) ? next.output_tokens : previous?.output_tokens ?? 0;
	return {
		input_tokens: countOf(next.input_tokens) > 0 ? next.input_tokens : previous?.input_tokens ?? 0,
		output_tokens: output,
		cache_read_input_tokens: next.cache_read_input_tokens ?? previous?.cache_read_input_tokens ?? 0,
		cache_creation_input_tokens: next.cache_creation_input_tokens ?? previous?.cache_creation_input_tokens ?? 0
	};
}
/**
* One warm CodeBuddy session for a host session id.
*
* Mirrors the Qoder session's shape: the host's tool calls are exposed through
* an in-process MCP server; each handler parks until the host delivers that
* round's results on its next request. The inner CLI keeps the conversation,
* so a continuation carries only new user text.
*/
var CodeBuddySession = class {
	sessionId;
	session = null;
	mcp = null;
	pairing = new ToolResultPairing();
	registered = /* @__PURE__ */ new Map();
	toolSchemas = [];
	queue = null;
	disposed = false;
	abortPending = false;
	turnEndKind;
	blockIndex = 0;
	textBlock;
	reasoningBlock;
	tools = [];
	openTool;
	callCounter = 0;
	callNonce = randomUUID().slice(0, 8);
	lastUsage;
	/**
	* The last prompt-side buckets a request actually measured.
	*
	* Kept across turns: a turn can end without a usable usage frame (aborted
	* before the first delta, or a transport that only sends the cumulative
	* result). Reusing the last real reading keeps the host's context pressure
	* at the provider's actual prompt instead of collapsing it to the CLI's
	* startup overhead.
	*/
	lastPromptUsage;
	/**
	* Ids of assistant messages whose streaming events this session consumed.
	*
	* Kept across turns, not reset with the turn: the echo of a tool round is
	* delivered on the next stream(), so the previous turn's id is exactly the
	* one that has to be recognised. Only the last few ids matter, and bounding
	* the list keeps a long-lived session from growing without limit.
	*/
	streamedMessageIds = /* @__PURE__ */ new Set();
	streamedMessageOrder = [];
	output = new TurnOutputAccounting();
	inputChars = 0;
	toolResultTimeoutMs;
	abortGraceMs;
	region = "global";
	model = "";
	effort;
	systemPrompt;
	cwd;
	/** Context budget the host shows for this session, when a model offers one. */
	contextWindow;
	/** Budget already pushed to the CLI, keyed by model and value. */
	appliedWindow;
	/** Host messages already fed to the inner session, for continuation planning. */
	fedMessages;
	/** Host system prompt last applied; informational for the adapter. */
	fedSystem;
	constructor(sessionId, initialModel, runtime = {}) {
		this.sessionId = sessionId;
		this.model = initialModel;
		this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, 12e4);
		this.abortGraceMs = readLive(runtime.abortGraceMs, 5e3);
	}
	/** Point the session at a region, model and optional system prompt. */
	configure(region, model, options = {}) {
		this.region = region;
		this.model = model;
		this.effort = options.effort;
		this.systemPrompt = options.system;
		if (options.cwd !== void 0) this.cwd = options.cwd;
		if (options.contextWindow !== void 0) this.contextWindow = options.contextWindow;
	}
	/**
	* Push the host-visible context window into the inner session.
	*
	* The CLI resolves its own budget (`override > model default > physical
	* limit`) and both its compaction trigger and the upstream gateway enforce
	* that budget. A global-catalog model such as `deepseek-v4.1-flash` declares
	* `supportedLengths [300K, 1M]` with a 300K default, so a session left alone
	* compacts (and the gateway rejects) anything past 276K — while the host,
	* told 1M, keeps showing and feeding a larger history. Replaying that history
	* then collapses to a summary. Applying the same number the host divides by
	* keeps the two in step; the adapter therefore sends a window for every model
	* it knows about, not only the ones that advertise a choice — the mainland
	* catalog declares no lengths anywhere and its physical `maxInputTokens` is a
	* provider number the CLI is free to ignore when left to itself.
	*
	* A rejected value keeps the CLI on its own default, which is the one case
	* where the two denominators can still disagree; it is reported nowhere, so
	* the host's figure stays the visible contract.
	*/
	async applyContextWindow(session) {
		const window = this.contextWindow;
		if (window === void 0) return;
		const key = `${this.model}:${window}`;
		if (this.appliedWindow === key) return;
		this.appliedWindow = key;
		try {
			await session.setConfig({ contextWindow: window });
		} catch {}
	}
	/**
	* Remember the host tools and register them with this session's MCP server.
	*
	* Registration must happen before the CLI connects: the MCP SDK refuses a
	* tool added afterwards. The first turn calls this before the session — and
	* therefore its MCP server — exists, so the schemas are kept and replayed by
	* {@link ensureStarted}. Returning early there left the model with no host
	* tools at all, and it fell back to CodeBuddy's built-in `Bash`, which the
	* host could only answer with "unknown tool".
	*/
	ensureTools(tools) {
		this.toolSchemas = tools;
		this.registerTools();
	}
	registerTools() {
		if (this.mcp === null) return;
		for (const schema of this.toolSchemas) {
			const hash = JSON.stringify(schema.parameters ?? {});
			if (this.registered.get(schema.name) === hash) continue;
			const shape = jsonSchemaToShape(schema.parameters ?? {});
			try {
				this.mcp.instance.registerTool(schema.name, {
					description: schema.description.length > 0 ? schema.description : schema.name,
					inputSchema: shape
				}, async () => {
					const result = await this.pairing.claim(this.toolResultTimeoutMs);
					return {
						content: result.content,
						...result.isError ? { isError: true } : {}
					};
				});
			} catch {
				continue;
			}
			this.registered.set(schema.name, hash);
		}
	}
	/** Hand the host's tool results to parked or buffered handlers. */
	deliverToolResults(tail) {
		let freshUserTurn = false;
		const delivered = /* @__PURE__ */ new Set();
		for (const message of tail) {
			if (message.role === "user") {
				freshUserTurn = true;
				continue;
			}
			if (message.role !== "tool") continue;
			delivered.add(this.pairing.deliver(String(message.toolCallId), {
				content: renderCodeBuddyResult(message.content),
				isError: message.isError === true
			}));
		}
		this.pairing.beginHostRequest(delivered, freshUserTurn);
	}
	/** Run one host turn; `feed` is new user content, or null for a tool continuation. */
	async *stream(options, feed) {
		if (this.queue !== null) throw new Error(`CodeBuddy session ${this.sessionId} already has a turn in flight`);
		if (this.disposed) throw new Error(`CodeBuddy session ${this.sessionId} was disposed`);
		const session = await this.ensureStarted();
		this.queue = new TurnQueue();
		this.resetTurnState();
		const signal = options.signal;
		let abortTimer;
		const onAbort = () => {
			this.abortPending = true;
			session.interrupt().catch(() => void 0);
			abortTimer = setTimeout(() => this.endTurn({
				kind: "aborted",
				failure: {
					message: "CodeBuddy session aborted by host",
					code: "ABORTED"
				}
			}), this.abortGraceMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await session.setModel(this.model);
			await this.applyContextWindow(session);
			if (feed !== null && feed.length > 0) {
				const content = typeof feed === "string" ? feed : feed.filter((block) => block.type !== "text" || block.text.length > 0);
				if (content.length > 0) {
					this.inputChars += typeof content === "string" ? content.length : contentChars(content);
					await session.send(toCodeBuddyUserMessage(this.sessionId, content));
				}
			}
			this.consume(session);
			for await (const item of this.queue) {
				if (item.kind === "chunk") {
					yield item.chunk;
					continue;
				}
				if (item.usage !== void 0) yield {
					type: "usage",
					usage: item.usage
				};
				yield {
					type: "finish",
					reason: item.reason
				};
				return;
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (abortTimer !== void 0) clearTimeout(abortTimer);
			if (this.turnEndKind === "aborted" || this.turnEndKind === "error") this.pairing.forgetUnclaimed();
			this.queue = null;
			this.abortPending = false;
		}
	}
	/** Tear the inner CLI down; parked handlers settle with a cancellation. */
	close() {
		if (this.disposed) return;
		this.disposed = true;
		this.pairing.clear();
		this.session?.close();
		this.session = null;
	}
	async ensureStarted() {
		if (this.session !== null) return this.session;
		const sdk = await loadCodeBuddySdk();
		this.mcp ??= sdk.createSdkMcpServer({
			name: MCP_SERVER_NAME,
			tools: []
		});
		this.registerTools();
		const session = sdk.unstable_v2_createSession({
			environment: codeBuddyEnvironment(this.region),
			sessionId: randomUUID(),
			model: this.model,
			mcpServers: { [MCP_SERVER_NAME]: this.mcp },
			canUseTool: this.canUseTool,
			tools: [],
			...cliEnv(this.region),
			settingSources: [],
			includePartialMessages: true,
			persistSession: false,
			...this.effort === void 0 ? {} : { effort: this.effort },
			...this.systemPrompt === void 0 ? {} : { systemPrompt: this.systemPrompt },
			...this.cwd === void 0 ? {} : { cwd: this.cwd }
		});
		this.session = session;
		return session;
	}
	canUseTool = (toolName, _input, options) => {
		if (isHostTool(toolName)) {
			if (options.toolUseID !== void 0) this.pairing.announce(options.toolUseID);
			return Promise.resolve({
				behavior: "allow",
				...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
			});
		}
		return Promise.resolve({
			behavior: "deny",
			message: "本会话是宿主 agent 的 LLM 后端，不直接执行工具。宿主的工具已通过 MCP 挂入，直接调用它们即可。",
			...options.toolUseID === void 0 ? {} : { toolUseID: options.toolUseID }
		});
	};
	async consume(session) {
		try {
			for await (const message of session.stream()) {
				this.handle(message);
				if (this.queue === null || this.queue.isClosed) return;
			}
			this.endTurn({
				kind: "error",
				failure: {
					message: "CodeBuddy session stream ended unexpectedly",
					code: "STREAM_CLOSED"
				}
			});
		} catch (error) {
			this.endTurn({
				kind: "error",
				failure: {
					message: authErrorText(this.region, error),
					code: "BACKEND_TURN_ERROR"
				}
			});
		}
	}
	handle(message) {
		if (message.type === "stream_event") {
			const event = message.event;
			if (event.type === "message_start") {
				const usage = event.message.usage;
				if (measuredPrompt(usage)) this.lastUsage = usage;
				this.rememberStreamedMessage(event.message.id);
				return;
			}
			if (event.type === "content_block_start") {
				const block = event.content_block;
				if (block?.type === "tool_use") {
					if (!isHostTool(block.name ?? "")) return;
					const callId = `cb-${this.callNonce}-${++this.callCounter}`;
					if (typeof block.id === "string" && block.id.length > 0) this.pairing.mapHostCall(callId, block.id);
					const chunkIndex = this.blockIndex++;
					const initial = block.input !== void 0 && block.input !== null && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
					this.openTool = {
						chunkIndex,
						callId,
						name: hostToolName(block.name ?? ""),
						arguments: initial
					};
					this.countOutput(this.openTool.name);
					this.countOutput(initial);
					this.emit({
						type: "block-start",
						index: chunkIndex,
						blockType: "tool-call"
					});
					this.emit({
						type: "tool-call-delta",
						index: chunkIndex,
						id: ToolCallId(callId),
						name: this.openTool.name,
						argumentsDelta: ""
					});
				}
				return;
			}
			if (event.type === "content_block_delta") {
				const delta = event.delta;
				if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
					if (this.textBlock === void 0) {
						this.textBlock = {
							index: this.blockIndex++,
							text: ""
						};
						this.emit({
							type: "block-start",
							index: this.textBlock.index,
							blockType: "text"
						});
					}
					this.textBlock.text += delta.text;
					this.countOutput(delta.text);
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text: delta.text
					});
				} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
					if (this.reasoningBlock === void 0) {
						this.reasoningBlock = {
							index: this.blockIndex++,
							text: ""
						};
						this.emit({
							type: "block-start",
							index: this.reasoningBlock.index,
							blockType: "reasoning"
						});
					}
					this.reasoningBlock.text += delta.thinking;
					this.output.addReasoning(delta.thinking);
					this.emit({
						type: "reasoning-delta",
						index: this.reasoningBlock.index,
						text: delta.thinking
					});
				} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && this.openTool !== void 0) {
					this.openTool.arguments += delta.partial_json;
					this.countOutput(delta.partial_json);
					this.emit({
						type: "tool-call-delta",
						index: this.openTool.chunkIndex,
						id: ToolCallId(this.openTool.callId),
						argumentsDelta: delta.partial_json
					});
				}
				return;
			}
			if (event.type === "content_block_stop") {
				if (this.openTool !== void 0) {
					this.emit({
						type: "block-end",
						index: this.openTool.chunkIndex,
						block: {
							type: "tool-call",
							id: ToolCallId(this.openTool.callId),
							name: this.openTool.name,
							arguments: this.openTool.arguments
						}
					});
					this.tools.push(this.openTool);
					this.openTool = void 0;
				}
				return;
			}
			if (event.type === "message_delta") {
				const usage = event.usage;
				if (usage !== void 0) this.lastUsage = mergeTurnUsage(this.lastUsage, usage);
				return;
			}
			if (event.type === "message_stop") {
				if (this.tools.length > 0) this.endTurn({ kind: "tool-calls" });
				return;
			}
			return;
		}
		if (message.type === "assistant") {
			const echoOf = message.message.id;
			if (typeof echoOf === "string" && this.streamedMessageIds.has(echoOf)) return;
			if (this.textBlock === void 0 && this.tools.length === 0) {
				for (const block of message.message.content) if (block.type === "tool_use") {
					this.countOutput(block.name);
					this.countOutput(JSON.stringify(block.input ?? ""));
				}
				const text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
				if (text.length > 0) {
					this.textBlock = {
						index: this.blockIndex++,
						text
					};
					this.countOutput(text);
					this.emit({
						type: "block-start",
						index: this.textBlock.index,
						blockType: "text"
					});
					this.emit({
						type: "text-delta",
						index: this.textBlock.index,
						text
					});
				}
			}
			return;
		}
		if (message.type === "result") {
			if (this.abortPending) {
				this.endTurn({
					kind: "aborted",
					failure: {
						message: "CodeBuddy turn aborted by host",
						code: "ABORTED"
					}
				});
				return;
			}
			if (this.tools.length > 0) {
				this.endTurn({ kind: "tool-calls" });
				return;
			}
			if (message.is_error === true) {
				const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : "unknown error";
				this.endTurn({
					kind: "error",
					failure: {
						message: `CodeBuddy turn failed: ${errors}`,
						code: "BACKEND_TURN_ERROR"
					}
				});
				return;
			}
			if (this.textBlock === void 0 && this.reasoningBlock === void 0) {
				this.endTurn({
					kind: "error",
					failure: {
						message: "CodeBuddy returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				});
				return;
			}
			this.endTurn({ kind: "stop" });
		}
	}
	/** Record that one assistant message reached the host as streaming events. */
	rememberStreamedMessage(id) {
		if (typeof id !== "string" || id.length === 0 || this.streamedMessageIds.has(id)) return;
		this.streamedMessageIds.add(id);
		this.streamedMessageOrder.push(id);
		if (this.streamedMessageOrder.length > 32) {
			const oldest = this.streamedMessageOrder.shift();
			if (oldest !== void 0) this.streamedMessageIds.delete(oldest);
		}
	}
	resetTurnState() {
		this.blockIndex = 0;
		this.textBlock = void 0;
		this.reasoningBlock = void 0;
		this.openTool = void 0;
		this.tools = [];
		this.inputChars = 0;
		this.output.reset();
		this.lastUsage = void 0;
		this.turnEndKind = void 0;
	}
	emit(chunk) {
		this.queue?.push({
			kind: "chunk",
			chunk
		});
	}
	countOutput(text) {
		this.output.addOutput(text);
	}
	usage() {
		const metered = this.lastUsage;
		const local = this.output.usage();
		const measuredOutput = countOf(metered?.output_tokens);
		const outputTokens = measuredOutput > 0 ? measuredOutput : Math.max(1, Math.ceil(local.outputTokens));
		const reasoning = local.reasoningTokens === void 0 ? {} : { reasoningTokens: Math.min(outputTokens, Math.max(1, Math.ceil(local.reasoningTokens))) };
		if (metered !== void 0 && countOf(metered.input_tokens) > 0) {
			const cacheRead = countOf(metered.cache_read_input_tokens);
			const cacheWrite = countOf(metered.cache_creation_input_tokens);
			const inputTokens = Math.max(0, countOf(metered.input_tokens) - cacheRead - cacheWrite);
			this.lastPromptUsage = {
				inputTokens,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite
			};
			return {
				inputTokens,
				outputTokens,
				...reasoning,
				cacheReadTokens: cacheRead,
				cacheWriteTokens: cacheWrite,
				totalTokens: inputTokens + cacheRead + cacheWrite + outputTokens
			};
		}
		if (this.lastPromptUsage !== void 0) {
			const prompt = this.lastPromptUsage;
			return {
				inputTokens: prompt.inputTokens,
				outputTokens,
				...reasoning,
				cacheReadTokens: prompt.cacheReadTokens,
				cacheWriteTokens: prompt.cacheWriteTokens,
				totalTokens: prompt.inputTokens + prompt.cacheReadTokens + prompt.cacheWriteTokens + outputTokens
			};
		}
		const inputTokens = Math.max(1, Math.ceil(estimateTextTokens(this.inputChars, 0)));
		return {
			inputTokens,
			outputTokens,
			...reasoning,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: inputTokens + outputTokens
		};
	}
	endTurn(reason) {
		if (this.queue === null) return;
		this.turnEndKind = reason.kind;
		if (this.textBlock !== void 0) this.emit({
			type: "block-end",
			index: this.textBlock.index,
			block: {
				type: "text",
				text: this.textBlock.text
			}
		});
		if (this.reasoningBlock !== void 0) this.emit({
			type: "block-end",
			index: this.reasoningBlock.index,
			block: {
				type: "reasoning",
				text: this.reasoningBlock.text
			}
		});
		this.queue.push({
			kind: "turn-end",
			reason,
			usage: this.usage()
		});
		this.queue.close();
	}
};
/** Render host tool-result blocks into the MCP content the inner model reads. */
function renderCodeBuddyResult(blocks) {
	if (!Array.isArray(blocks)) return [{
		type: "text",
		text: String(blocks ?? "")
	}];
	const content = [];
	for (const block of blocks) if (block.type === "text") content.push({
		type: "text",
		text: block.text ?? ""
	});
	else if (block.type === "image") content.push({
		type: "text",
		text: "[图片结果未转发给 CodeBuddy]"
	});
	else content.push({
		type: "text",
		text: JSON.stringify(block)
	});
	return content;
}
/**
* Warm sessions keyed by host session id. A region change retires the old
* session rather than mutating one, because the CLI process was started with
* the previous region's endpoint.
*/
var CodeBuddySessionManager = class {
	maxSessions;
	runtime;
	sessions = /* @__PURE__ */ new Map();
	constructor(maxSessions, runtime = {}) {
		this.maxSessions = maxSessions;
		this.runtime = runtime;
	}
	forSession(sessionId, region, model) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			if (existing.region !== region) {
				existing.session.close();
				this.sessions.delete(sessionId);
			} else {
				this.sessions.delete(sessionId);
				this.sessions.set(sessionId, existing);
				return existing.session;
			}
		}
		const session = new CodeBuddySession(sessionId, model, this.runtime);
		this.sessions.set(sessionId, {
			session,
			region
		});
		const cap = readLive(this.maxSessions, 8);
		while (this.sessions.size > cap) {
			const oldest = this.sessions.keys().next();
			if (oldest.done === true) break;
			const victim = this.sessions.get(oldest.value);
			this.sessions.delete(oldest.value);
			victim?.session.close();
		}
		return session;
	}
	dispose(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (entry === void 0) return;
		this.sessions.delete(sessionId);
		entry.session.close();
	}
	closeAll() {
		for (const entry of this.sessions.values()) entry.session.close();
		this.sessions.clear();
	}
};
/** A one-shot turn, used for titles and compaction summaries. */
async function codeBuddyColdStream(region, prompt, model, options) {
	const chunks = [];
	let text = "";
	const signal = options.signal;
	const session = (await loadCodeBuddySdk()).unstable_v2_createSession({
		environment: codeBuddyEnvironment(region),
		sessionId: randomUUID(),
		...model === void 0 ? {} : { model },
		...cliEnv(region),
		tools: [],
		settingSources: [],
		persistSession: false
	});
	const onAbort = () => {
		session.interrupt().catch(() => void 0);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.send(prompt);
		for await (const message of session.stream()) {
			if (signal?.aborted === true) break;
			if (message.type === "assistant") text += message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		}
	} catch (error) {
		if (signal?.aborted !== true) throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		session.close();
	}
	if (signal?.aborted === true) {
		chunks.push({
			type: "finish",
			reason: {
				kind: "aborted",
				failure: {
					message: "aborted by host",
					code: "ABORTED"
				}
			}
		});
		return chunks;
	}
	if (text.length === 0) {
		chunks.push({
			type: "finish",
			reason: {
				kind: "error",
				failure: {
					message: "CodeBuddy side-channel returned no content",
					code: EMPTY_RESPONSE_CODE
				}
			}
		});
		return chunks;
	}
	chunks.push({
		type: "block-start",
		index: 0,
		blockType: "text"
	});
	for (let i = 0; i < text.length; i += 192) chunks.push({
		type: "text-delta",
		index: 0,
		text: text.slice(i, i + 192)
	});
	chunks.push({
		type: "block-end",
		index: 0,
		block: {
			type: "text",
			text
		}
	});
	chunks.push({
		type: "usage",
		usage: {
			inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
			outputTokens: Math.max(1, Math.ceil(text.length / 4))
		}
	});
	chunks.push({
		type: "finish",
		reason: { kind: "stop" }
	});
	return chunks;
}
//#endregion
//#region src/codebuddy-adapter.ts
/**
* `CodeBuddyAdapter`: route the harness LLM seam onto a CodeBuddy account.
*
* One CodeBuddy provider serves both login regions; the account, catalog and
* warm sessions all follow the configured region. The inner CLI owns the
* conversation, so the adapter only decides what new text to send and which
* tool round the host is answering.
*
* @module dsh-agent-sdk-bridge/codebuddy-adapter
*/
/** The CodeBuddy provider route. */
const CODEBUDDY_PROVIDER = "codebuddy";
const NO_MODELS$1 = [];
const NO_ALIASES$1 = {};
/** Map a harness-side id onto a CodeBuddy model value. */
function resolveCodeBuddyModelId(model, aliases = {}) {
	const configured = aliases[model] ?? aliases[model.toLowerCase()];
	if (configured !== void 0 && configured.length > 0) return configured;
	const stripped = model.startsWith("codebuddy-") ? model.slice(10) : model;
	return stripped.length > 0 ? stripped : "default-model";
}
function modelInfo$1(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.vision ? ["text", "image"] : ["text"]
	};
}
/** The CodeBuddy-backed adapter. */
var CodeBuddyAdapter = class extends LlmAdapter {
	options;
	sessions;
	catalog;
	accounts;
	auth = new CodeBuddyAuth();
	disabledCache = /* @__PURE__ */ new Map();
	/** Last verified image capability, keyed `${region}:${model}`. */
	knownVision = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		super();
		this.options = options;
		this.sessions = new CodeBuddySessionManager(options.maxSessions ?? 8, {
			toolResultTimeoutMs: options.toolResultTimeoutMs,
			abortGraceMs: options.abortGraceMs
		});
		this.catalog = new CodeBuddyCatalog(options.region ?? (() => "global"), options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 3e4);
		this.accounts = new CodeBuddyAccountReader(options.region ?? (() => "global"), options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 3e4);
	}
	get region() {
		return readLive(this.options.region ?? (() => "global"), "global");
	}
	disabledFor(region) {
		const source = this.options.disabledModels?.(region) ?? NO_MODELS$1;
		const key = source.join("\0");
		const cached = this.disabledCache.get(region);
		if (cached?.key === key) return cached.set;
		const set = new Set(source);
		this.disabledCache.set(region, {
			key,
			set
		});
		return set;
	}
	get aliases() {
		return readLive(this.options.modelAliases, NO_ALIASES$1);
	}
	get displayName() {
		return readLive(this.options.displayName, "CodeBuddy");
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.displayName
		};
	}
	/** The live catalog, unfiltered (the page must show switched-off models). */
	async describeCatalog(region = this.region) {
		if (!this.isSignedIn(region)) return [];
		const models = await this.catalog.models(region);
		for (const model of models) this.knownVision.set(`${region}:${model.id}`, model.vision);
		return models;
	}
	/** Whether the selected (or given) region has a stored login. */
	isSignedIn(region = this.region) {
		return this.auth.status(region).signedIn === true;
	}
	/** Why the last catalog read failed, for the page's guidance. */
	catalogError(region = this.region) {
		if (!this.isSignedIn(region)) return "请先登录 CodeBuddy，登录后才会读取并显示模型目录。";
		return this.catalog.error(region);
	}
	invalidateCatalog(region) {
		this.catalog.invalidate(region);
	}
	/** The signed-in account, or the reason it could not be read. */
	async usageInfo(fresh = false, region) {
		return this.accounts.read(fresh, region);
	}
	invalidateUsage(region) {
		this.accounts.invalidate(region);
	}
	/** Login progress for one region; the page polls this. */
	authStatus(region) {
		return this.auth.status(region);
	}
	startLogin(region) {
		return this.auth.start(region, (ok) => {
			if (!ok) return;
			this.sessions.closeAll();
			this.invalidateCatalog(region);
			this.invalidateUsage(region);
		});
	}
	async logout(region) {
		const result = await this.auth.logout(region);
		this.sessions.closeAll();
		this.invalidateCatalog(region);
		this.invalidateUsage(region);
		return result;
	}
	isModelDisabled(id, region = this.region) {
		return this.disabledFor(region).has(id);
	}
	/** Whether the resolved model accepts images (drives whether pixels are sent). */
	async modelVision(model) {
		const target = resolveCodeBuddyModelId(model, this.aliases);
		const key = `${this.region}:${target}`;
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.models())).find((entry) => entry.id === target);
		if (live !== void 0) {
			this.knownVision.set(key, live.vision);
			return live.vision;
		}
		return this.knownVision.get(key) === true;
	}
	/**
	* Resolve a feed's images into base64 for the CLI's vision blocks.
	*
	* Only references the host can actually read become pixels; the rest keep
	* their handle text, so one unreadable attachment degrades that part of the
	* prompt instead of failing the whole turn.
	*/
	async resolveFeedImages(feed, vision, signal) {
		const map = /* @__PURE__ */ new Map();
		const readImage = this.options.readImage;
		if (!vision || readImage === void 0) return map;
		for (const ref of feedImageRefs(feed)) {
			const key = String(ref.attachmentId);
			if (map.has(key)) continue;
			try {
				const image = await readImage(ref, signal);
				if (image !== void 0) map.set(key, {
					data: Buffer.from(image.bytes).toString("base64"),
					mediaType: image.mediaType
				});
			} catch {}
		}
		return map;
	}
	/**
	* Turn a feed into what one CLI turn receives.
	*
	* A text-only feed stays a plain string (the historical shape). A feed with
	* readable images becomes the SDK's `ContentBlock[]`, because that is the
	* only shape the CLI sends to the model as pixels.
	*/
	async buildFeed(feed, vision, signal) {
		if (typeof feed === "string") return feed;
		if (!vision) return feedToText(feed, this.options.imagePath);
		const parts = resolvedFeedParts(feed, await this.resolveFeedImages(feed, vision, signal));
		if (!parts.some((part) => part.type !== "text")) return parts.map((part) => part.type === "text" ? part.text : "").join("\n\n");
		const content = [];
		for (const part of parts) {
			if (part.type === "text") {
				content.push({
					type: "text",
					text: part.text
				});
				continue;
			}
			const path = this.options.imagePath?.(part.attachment);
			content.push({
				type: "text",
				text: part.type === "image-unreadable" && path === void 0 ? `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]` : imageRefText(part.attachment, path)
			});
			if (part.type === "image-unreadable") continue;
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: part.mediaType,
					data: part.data
				}
			});
		}
		return content;
	}
	/**
	* The window this model actually runs with.
	*
	* The user's override only applies where the provider accepts one. Every
	* model in the current catalog reports `supportedLengths: null`, so the CLI
	* answers a `set_config.contextWindow` with `Allowed: <none>`; a stored
	* override would then make DSH show a denominator the upstream never uses,
	* which is exactly how the context ring drifted.
	*/
	contextWindowFor(id, region = this.region) {
		const override = this.options.modelContextWindows?.(region)[id];
		if (override === void 0) return void 0;
		const live = this.models(region).find((entry) => entry.id === id);
		if (live === void 0) return override;
		return live.contextWindows.includes(override) ? override : void 0;
	}
	/** The catalog snapshot the adapter last read (empty before the first read). */
	models(region) {
		return this.catalog.snapshot(region) ?? [];
	}
	/** Whether this model lets the user pick a context budget at all. */
	supportsContextWindowChoice(id, region = this.region) {
		const live = this.models(region).find((entry) => entry.id === id);
		return live !== void 0 && live.contextWindows.length > 0;
	}
	async listModels(provider) {
		const region = this.region;
		if (!this.isSignedIn(region)) return [];
		const models = await this.catalog.models(region);
		const disabled = this.disabledFor(region);
		return models.filter((model) => !disabled.has(model.id)).map((model) => modelInfo$1(provider, model));
	}
	async resolveModel(provider, model) {
		const target = resolveCodeBuddyModelId(model, this.aliases);
		const key = `${this.region}:${target}`;
		const live = (await cachedModels(this.catalog.snapshot(), () => this.catalog.models())).find((entry) => entry.id === target);
		if (live !== void 0) {
			this.knownVision.set(key, live.vision);
			const reasoning = reasoningInfo(live.reasoningEfforts, readLiveOptional(this.options.defaultReasoningEffort), (live.reasoningEfforts?.length ?? 0) > 0);
			return {
				provider,
				id: model,
				name: live.name,
				...live.description === void 0 ? {} : { description: live.description },
				inputModalities: live.vision ? ["text", "image"] : ["text"],
				context: { contextWindow: this.contextWindowFor(target) ?? live.defaultContextWindow },
				defaultMaxTokens: live.maxOutputTokens ?? readLive(this.options.defaultMaxTokens, 32e3),
				...reasoning === void 0 ? {} : { reasoning }
			};
		}
		const reasoning = reasoningInfo(void 0, readLiveOptional(this.options.defaultReasoningEffort), true);
		return {
			provider,
			id: model,
			name: model,
			inputModalities: this.knownVision.get(key) === true ? ["text", "image"] : ["text"],
			context: { contextWindow: this.contextWindowFor(target) ?? 2e5 },
			defaultMaxTokens: readLive(this.options.defaultMaxTokens, CODEBUDDY_DEFAULT_MAX_TOKENS),
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.dispatch(options)
		};
	}
	async *stream(options) {
		yield* this.dispatch(options);
	}
	async *dispatch(options) {
		const region = this.region;
		if (!this.isSignedIn(region)) throw new Error(`${region === "cn" ? "CodeBuddy 国内版" : "CodeBuddy 国际版"}尚未登录，请先在设置 → CodeBuddy 中登录。`);
		const model = resolveCodeBuddyModelId(options.model, this.aliases);
		if (options.sessionId === void 0 || options.purpose !== void 0) {
			const prompt = feedToText(renderInitialFeed(options.system, options.messages, this.options.imagePath), this.options.imagePath) + "\n（这是一次性旁路请求，直接输出下一条助手回复。）";
			for (const chunk of await codeBuddyColdStream(region, prompt, model, options)) yield chunk;
			return;
		}
		const sessionId = String(options.sessionId);
		const effort = options.reasoningEffort ?? readLiveOptional(this.options.defaultReasoningEffort);
		let session = this.sessions.forSession(sessionId, region, model);
		if (session.fedMessages === void 0) {
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		const tail = options.messages.slice(session.fedMessages.length);
		session.deliverToolResults(tail);
		const plan = planContinuation(session.fedMessages, options.messages);
		if (plan.rebuild) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, region, model);
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		session.configure(region, model, {
			effort,
			system: options.system,
			cwd: this.cwdOf(options),
			...await this.windowOption(model)
		});
		session.ensureTools(options.tools ?? []);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const vision = await this.modelVision(options.model);
		const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, vision, options.signal);
		yield* session.stream(options, feed);
	}
	async *firstTurn(session, options, region, model, effort) {
		session.configure(region, model, {
			effort,
			system: options.system,
			cwd: this.cwdOf(options),
			...await this.windowOption(model)
		});
		session.ensureTools(options.tools ?? []);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const vision = await this.modelVision(options.model);
		const feed = await this.buildFeed(renderInitialFeed(void 0, options.messages, this.options.imagePath), vision, options.signal);
		yield* session.stream(options, feed);
	}
	/**
	* The context window the host and the inner session must agree on.
	*
	* Only a model that offers selectable budgets is configured: one fixed
	* window rejects every value, so the CLI's own default already matches what
	* the host shows. For a model with choices the adapter sends the picked
	* value; returning to "default" sends the model's own default budget, since
	* the CLI rejects a null clear (`contextWindow must be a positive safe
	* integer`). The override lives for the life of the CLI process, so the
	* default has to be sent explicitly to drop a previous choice.
	*/
	async windowOption(model) {
		const live = (await this.catalog.models(this.region)).find((entry) => entry.id === model);
		if (live === void 0 || live.contextWindows.length === 0) return {};
		const chosen = this.options.modelContextWindows?.(this.region)[model];
		return { contextWindow: chosen !== void 0 && live.contextWindows.includes(chosen) ? chosen : live.defaultContextWindow };
	}
	cwdOf(options) {
		return options.cwd;
	}
	close() {
		this.sessions.closeAll();
	}
};
//#endregion
//#region src/minimax-cli.ts
/**
* The MiniMax Code CLI (`mcode`): locating it and running its installer.
*
* MiniMax ships `@minimax-ai/code` as a global npm package whose `mcode`
* launcher is a Node shim. Its native SQLite dependency is installed by a
* postinstall script, and npm 12 blocks install scripts unless they are named
* with `--allow-scripts`; a plain `npm i -g` leaves a CLI that cannot start.
* The installer below therefore passes the flags the package documents.
*
* @module dsh-agent-sdk-bridge/minimax-cli
*/
/** The npm package and the version verified to work with native SQLite. */
const PACKAGE = "@minimax-ai/code";
const INSTALL_VERSION = "0.6.12";
const INSTALL_FLAGS = [
	"--ignore-scripts=false",
	"--include=optional",
	"--allow-scripts=@minimax-ai/code,better-sqlite3",
	"--registry",
	"https://registry.npmjs.org/",
	"--foreground-scripts"
];
function fromJsEntry(path) {
	return {
		command: process.execPath,
		args: [path],
		cliPath: path
	};
}
function fromShim(shim) {
	if (shim.endsWith(".cmd") || shim.endsWith(".bat")) {
		try {
			const text = readFileSync(shim, "utf8");
			const match = /["']([^"']*node_modules[\\/]@minimax-ai[\\/]code[\\/]cli\.js)["']/.exec(text);
			if (match !== null && existsSync(match[1])) return fromJsEntry(match[1]);
		} catch {}
		const sibling = join(dirname(shim), "node_modules", "@minimax-ai", "code", "cli.js");
		if (existsSync(sibling)) return fromJsEntry(sibling);
		return {
			command: process.env.ComSpec ?? "cmd.exe",
			args: [
				"/d",
				"/c",
				shim
			]
		};
	}
	if (shim.endsWith(".js") || shim.endsWith(".mjs")) return fromJsEntry(shim);
	try {
		const real = realpathSync(shim);
		if (real.endsWith(".js") || real.endsWith(".mjs")) return fromJsEntry(real);
	} catch {}
	return {
		command: shim,
		args: []
	};
}
/**
* Locate `mcode`.
*
* `MCODE_CLI_PATH` wins (a cli.js path or an executable); otherwise the PATH
* shims and the global npm prefixes are checked. The explicit cli.js lookup
* matters on Windows, where spawning a `.cmd` for ACP would put cmd.exe between
* the protocol streams.
*/
function resolveMinimaxCli() {
	const override = process.env.MCODE_CLI_PATH?.trim();
	if (override !== void 0 && override.length > 0 && existsSync(override)) return fromShim(override);
	const names = process.platform === "win32" ? [
		"mcode.cmd",
		"mcode.exe",
		"mcode"
	] : ["mcode"];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (directory.trim() === "") continue;
		for (const name of names) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) return fromShim(candidate);
		}
	}
	const home = homedir();
	const candidates = process.platform === "win32" ? [
		join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm", "node_modules", PACKAGE, "cli.js"),
		join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "npm", "node_modules", PACKAGE, "cli.js"),
		join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node_modules", PACKAGE, "cli.js")
	] : [
		join(home, ".npm-global", "lib", "node_modules", PACKAGE, "cli.js"),
		join("/usr", "local", "lib", "node_modules", PACKAGE, "cli.js"),
		join("/usr", "lib", "node_modules", PACKAGE, "cli.js"),
		join(home, ".local", "lib", "node_modules", PACKAGE, "cli.js")
	];
	for (const candidate of candidates) if (existsSync(candidate)) return fromJsEntry(candidate);
}
/** The spawn argument list for one CLI invocation. */
function minimaxCliArgs(spec, args) {
	return [...spec.args, ...args];
}
/** Whether a value names an installer action. */
function isMinimaxSetupMode(value) {
	return value === "install" || value === "uninstall";
}
/** Cap on kept output. */
const MAX_LINES$1 = 400;
let current$1;
function absorb$1(run, chunk, done) {
	run.pending += run.decoder.decode(chunk, { stream: !done });
	const parts = run.pending.split(/\r\n|\r|\n/);
	run.pending = done ? "" : parts.pop() ?? "";
	for (const part of parts) {
		if (part.trim() === "") continue;
		run.lines.push(part);
	}
	if (done && run.pending.trim() !== "") run.lines.push(run.pending.trim());
	while (run.lines.length > MAX_LINES$1) {
		run.lines.shift();
		run.truncated = true;
	}
}
/**
* Start the npm installer or uninstaller.
*
* The command is fixed: the mode is an allow-list and no user input reaches
* argv. npm itself is run through cmd.exe on Windows because npm is a `.cmd`
* shim and Node refuses to spawn it directly on recent versions.
*/
function startMinimaxSetup(mode, onFinish) {
	if (current$1 !== void 0 && current$1.finishedAt === void 0) return {
		started: false,
		reason: "busy",
		error: "已经有一次 MiniMax CLI 安装在跑了，请等它结束。"
	};
	if (process.platform !== "win32" && mode === "install") return {
		started: false,
		reason: "unsupported",
		error: "一键安装 MiniMax CLI 目前只支持 Windows；请在终端手动执行 npm install -g @minimax-ai/code。"
	};
	const npmArgs = mode === "install" ? [
		"install",
		"--global",
		`${PACKAGE}@${INSTALL_VERSION}`,
		...INSTALL_FLAGS
	] : [
		"uninstall",
		"--global",
		PACKAGE
	];
	const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
	const args = process.platform === "win32" ? [
		"/d",
		"/c",
		"npm",
		...npmArgs
	] : npmArgs;
	const run = {
		child: void 0,
		mode,
		startedAt: Date.now(),
		lines: [],
		pending: "",
		decoder: new TextDecoder("utf-8"),
		truncated: false
	};
	const child = spawn(command, args, {
		cwd: homedir(),
		windowsHide: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	run.child = child;
	current$1 = run;
	const finish = (code) => {
		if (run.finishedAt !== void 0) return;
		run.finishedAt = Date.now();
		run.code = code;
		try {
			onFinish?.(code);
		} catch (error) {
			run.lines.push(`收尾回调失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};
	child.stdout?.on("data", (chunk) => absorb$1(run, chunk, false));
	child.stderr?.on("data", (chunk) => absorb$1(run, chunk, false));
	child.on("error", (error) => {
		run.lines.push(`无法启动 npm：${error instanceof Error ? error.message : String(error)}`);
		finish(null);
	});
	child.on("close", (code) => {
		absorb$1(run, /* @__PURE__ */ new Uint8Array(), true);
		finish(code);
	});
	return { started: true };
}
/** The latest installer run, with any not-yet-newlined tail included. */
function readMinimaxSetupStatus() {
	const spec = resolveMinimaxCli();
	const installed = spec !== void 0;
	if (current$1 === void 0) return {
		running: false,
		lines: [],
		truncated: false,
		installed,
		...spec?.cliPath === void 0 ? {} : { cliPath: spec.cliPath }
	};
	const run = current$1;
	const lines = run.pending.trim() === "" ? run.lines : [...run.lines, run.pending.trim()];
	return {
		running: run.finishedAt === void 0,
		mode: run.mode,
		startedAt: run.startedAt,
		...run.finishedAt === void 0 ? {} : {
			finishedAt: run.finishedAt,
			code: run.code ?? null
		},
		lines,
		truncated: run.truncated,
		installed,
		...spec?.cliPath === void 0 ? {} : { cliPath: spec.cliPath }
	};
}
/** Abandon a running installer. */
function stopMinimaxSetup() {
	if (current$1 !== void 0 && current$1.finishedAt === void 0) current$1.child.kill();
}
/** A small object facade for callers that prefer a service shape. */
var MinimaxCliSetup = class {
	start = startMinimaxSetup;
	status = readMinimaxSetupStatus;
	stop = stopMinimaxSetup;
};
//#endregion
//#region src/minimax.ts
/**
* MiniMax Code over the Agent Client Protocol.
*
* `mcode acp` is a stdio ACP server: the plugin starts one process per warm
* host session, negotiates capabilities, creates one ACP session, and streams
* `session/update` notifications back to the harness. Host tools are injected
* as an HTTP MCP server (`mcpServers` in `session/new`), so a tool call the
* model makes reaches this plugin and then the harness, exactly like the
* CodeBuddy path.
*
* Two MiniMax behaviours shape this module:
*
* - ACP has no way to turn off the CLI's built-in tools. The model may call
*   `bash`/`write`/`read` directly, which would bypass the harness. The client
*   watches `tool_call` notifications and cancels the prompt before execution;
*   the turn is then retried with a correction. Host MCP tools are the only
*   calls allowed through.
* - The CLI stores one auth state per region and selects it with
*   `MAVIS_REGION`; every process is pinned so the mainland and international
*   accounts can coexist.
*
* @module dsh-agent-sdk-bridge/minimax
*/
/** Default context capacity shown for a MiniMax model that declares none. */
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 512e3;
/** Default output cap; the published MiniMax models allow 128k. */
const MINIMAX_DEFAULT_MAX_TOKENS = 128e3;
/** How long one model catalog stays fresh. */
const MINIMAX_CACHE_TTL_MS = 3e5;
/** Bound for one ACP control round trip. */
const MINIMAX_FETCH_TIMEOUT_MS = 3e4;
/** The MCP server name the model sees; its tools are `mcp__dsh-host__*`. */
const MINIMAX_MCP_SERVER = "dsh-host";
/** Context choices the hosted models publish. */
const MINIMAX_CONTEXT_CHOICES = [MINIMAX_DEFAULT_CONTEXT_WINDOW, 1e6];
/** How many native-tool corrections a turn may trigger before it fails. */
const MAX_NATIVE_TOOL_RETRIES = 2;
/** The per-user CLI state directory. */
function minimaxDataDir() {
	const override = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
	return override !== void 0 && override.length > 0 ? override : join(homedir(), ".minimax");
}
/** Path of one region's auth-state file. */
function minimaxAuthStatePath(region) {
	const buildEnv = process.env.MAVIS_BUILD_ENV?.trim() || "prod";
	return join(minimaxDataDir(), "auth", buildEnv, minimaxCliRegion(region), "mcode-public", "auth-state.json");
}
/** Path of the credential file the CLI writes its OAuth token to. */
function minimaxAuthRecordPath(region) {
	const buildEnv = process.env.MAVIS_BUILD_ENV?.trim() || "prod";
	return join(minimaxDataDir(), "auth", buildEnv, minimaxCliRegion(region), "mcode-public", "auth.json");
}
/** The CLI command name, for error text. */
function minimaxCliCommand() {
	return "mcode";
}
/** The host-side MCP namespace the CLI exposes for the injected server. */
const HOST_TOOL_PREFIXES = [`mcp__${MINIMAX_MCP_SERVER}__`, `mcp__${MINIMAX_MCP_SERVER.replace(/[^a-zA-Z0-9]/g, "_")}__`];
/** Whether a CLI tool name belongs to this plugin's MCP server. */
function isHostMcpTool(name) {
	return HOST_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
/** The host-side name of an MCP tool, without the namespace. */
function hostMcpToolName(name) {
	for (const prefix of HOST_TOOL_PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length);
	return name;
}
/** Thinking-effort values an ACP config option advertises, minus `default`. */
function effortValues(options) {
	if (!Array.isArray(options)) return [];
	return options.map((entry) => typeof entry?.value === "string" ? entry.value : "").filter((value) => value.length > 0 && value !== "default");
}
/** Build one row from a model option entry and the efforts that model accepts. */
function modelRow(entry, efforts) {
	if (typeof entry?.value !== "string" || entry.value.length === 0) return void 0;
	return {
		id: entry.value,
		name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.value,
		...typeof entry.description === "string" && entry.description.length > 0 ? { description: entry.description } : {},
		contextWindows: [...MINIMAX_CONTEXT_CHOICES],
		defaultContextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
		vision: true,
		reasoning: efforts.length > 0,
		reasoningEfforts: [...efforts]
	};
}
/** The model config option's values as rows. */
function minimaxModelsFromConfigOptions(options) {
	if (!Array.isArray(options)) return [];
	const modelOption = options.find((option) => option?.category === "model" || option?.id === "model");
	const efforts = effortValues(options.find((option) => option?.id === "thinkingEffort" || option?.category === "thought_level")?.options);
	if (!Array.isArray(modelOption?.options)) return [];
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const entry of modelOption.options) {
		if (typeof entry?.value !== "string" || entry.value.length === 0 || seen.has(entry.value)) continue;
		seen.add(entry.value);
		const row = modelRow(entry, efforts);
		if (row !== void 0) models.push(row);
	}
	return models;
}
/**
* Read one region's stored auth state, without spawning anything.
*
* The file records its own region; a copy left over from another build or a
* CLI that rotates its layout must not be read as this region's login.
*/
function readAuthState(region) {
	try {
		const parsed = JSON.parse(readFileSync(minimaxAuthStatePath(region), "utf8"));
		if (typeof parsed.region === "string" && parsed.region !== minimaxCliRegion(region)) return void 0;
		return {
			...typeof parsed.status === "string" ? { status: parsed.status } : {},
			...typeof parsed.expiresAtMs === "number" ? { expiresAtMs: parsed.expiresAtMs } : {}
		};
	} catch {
		return;
	}
}
/** Whether the region has a stored login. */
function minimaxSignedIn(region) {
	return readAuthState(region)?.status === "authenticated";
}
/** Signed account gateway (the CLI's `agent` host). */
const MINIMAX_ACCOUNT_HOSTS = {
	cn: "https://agent.minimaxi.com",
	global: "https://agent.minimax.io"
};
/** Host serving the coding-plan quota. */
const MINIMAX_QUOTA_HOSTS = {
	cn: "https://www.minimaxi.com",
	global: "https://platform.minimax.io"
};
/** Salt the CLI signs account requests with. */
const MINIMAX_ACCOUNT_SALT = "I*7Cf%WZ#S&%1RlZJ&C2";
/** Bound for one account/quota read. */
const MINIMAX_USAGE_TIMEOUT_MS = 15e3;
/** How long one quota reading stays fresh. */
const MINIMAX_USAGE_CACHE_TTL_MS = 6e4;
/** Bound for one region-reachability probe. */
const MINIMAX_REGION_PROBE_TIMEOUT_MS = 5e3;
/** How long one reachability verdict stays fresh. */
const MINIMAX_REGION_ACCESS_TTL_MS = 3e4;
/** Domains the two sites serve their API and console from. */
const MINIMAX_INTL_DOMAIN = "minimax.io";
const MINIMAX_CN_DOMAIN = "minimaxi.com";
function hostMatches(hostname, domain) {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}
/**
* Whether a URL points at the other site.
*
* MiniMax's edge answers a request from the wrong side of the border with a
* 307 to the other site (`.io` -> `.minimaxi.com` and the reverse). The two
* are different origins, so a redirect also drops the Authorization header;
* that is why the CLI reports `401 token is required` instead of an
* actionable error, and why a stale token is not the real cause.
*/
function minimaxHostBelongsToOtherRegion(region, target) {
	let hostname;
	try {
		hostname = typeof target === "string" ? new URL(target).hostname : target.hostname;
	} catch {
		return false;
	}
	return region === "global" ? hostMatches(hostname, MINIMAX_CN_DOMAIN) : hostMatches(hostname, MINIMAX_INTL_DOMAIN);
}
/** The sentence the card and the chat surface show for a refused region. */
function minimaxRegionBlockMessage(region) {
	return region === "global" ? "本机 IP 不在 MiniMax 国际站的服务区域，国际站已拒绝连接（请求被重定向到国内站）。请切换到国内站，或更换网络后重试。" : "本机 IP 不在 MiniMax 国内站的服务区域，国内站已拒绝连接（请求被重定向到国际站）。请切换到国际站，或更换网络后重试。";
}
/** A region whose hosts refused this machine's network. */
var MinimaxRegionBlockedError = class extends Error {
	region;
	constructor(region) {
		super(minimaxRegionBlockMessage(region));
		this.region = region;
		this.name = "MinimaxRegionBlockedError";
	}
};
const regionAccessCache = /* @__PURE__ */ new Map();
/**
* Probes already on the wire.
*
* A region switch asks for the quota and the catalog at the same time, and
* both need the same verdict; sharing the request keeps them from disagreeing
* and spares the remote host a duplicate round trip.
*/
const regionAccessInflight = /* @__PURE__ */ new Map();
/** Forget a cached reachability verdict. */
function invalidateMinimaxRegionAccess(region) {
	if (region === void 0) regionAccessCache.clear();
	else regionAccessCache.delete(region);
}
function rememberRegionAccess(region, blocked) {
	regionAccessCache.set(region, {
		at: Date.now(),
		blocked
	});
}
/** The last verdict, for synchronous rendering under the card. */
function minimaxRegionBlockedCached(region) {
	const cached = regionAccessCache.get(region);
	return cached?.blocked === true && Date.now() - cached.at < MINIMAX_REGION_ACCESS_TTL_MS;
}
/**
* Probe the region's account host for a cross-region redirect.
*
* Only a redirect to the other site's domain counts as a block. A timeout or
* DNS failure leaves the previous verdict alone, so callers report the real
* network error instead of blaming the IP.
*/
async function minimaxRegionBlocked(region, options = {}) {
	const cached = regionAccessCache.get(region);
	if (options.fresh !== true && cached !== void 0 && Date.now() - cached.at < MINIMAX_REGION_ACCESS_TTL_MS) return cached.blocked;
	let pending = regionAccessInflight.get(region);
	if (pending === void 0) {
		pending = probeRegionAccess(region, options).finally(() => {
			regionAccessInflight.delete(region);
		});
		regionAccessInflight.set(region, pending);
	}
	return await pending;
}
async function probeRegionAccess(region, options) {
	const cached = regionAccessCache.get(region);
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeout = AbortSignal.timeout(MINIMAX_REGION_PROBE_TIMEOUT_MS);
	const signal = options.signal === void 0 ? timeout : AbortSignal.any([options.signal, timeout]);
	try {
		const response = await fetchImpl(`${MINIMAX_ACCOUNT_HOSTS[region]}/`, {
			redirect: "manual",
			signal,
			headers: { Accept: "text/html,application/json" }
		});
		const location = response.headers.get("location");
		const blocked = response.status >= 300 && response.status < 400 && location !== null && minimaxHostBelongsToOtherRegion(region, location);
		rememberRegionAccess(region, blocked);
		return blocked;
	} catch {
		return cached?.blocked === true;
	}
}
/** Whether one response is the edge redirecting this machine to the other site. */
function redirectTargetsOtherRegion(region, requestUrl, response) {
	if (response.status < 300 || response.status >= 400) return false;
	const location = response.headers.get("location");
	if (location === null) return false;
	try {
		return minimaxHostBelongsToOtherRegion(region, new URL(location, requestUrl));
	} catch {
		return false;
	}
}
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
function asString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** Read the OAuth access token the CLI stored for one region. */
function readStoredToken(region) {
	try {
		const parsed = JSON.parse(readFileSync(minimaxAuthRecordPath(region), "utf8"));
		for (const record of Object.values(parsed.records ?? {})) {
			const token = record?.accessToken;
			if (typeof token === "string" && token.trim().length > 0) return token.trim();
		}
	} catch {}
}
function minimaxMd5(value) {
	return createHash("md5").update(value).digest("hex");
}
/** Build one signed-gateway URL exactly as the CLI does. */
function minimaxAccountUrl(region, path, nowMs, realUserId) {
	const url = new URL(path, MINIMAX_ACCOUNT_HOSTS[region]);
	const lang = region === "cn" ? "zh" : "en";
	url.search = new URLSearchParams({
		device_platform: "mcode",
		biz_id: "3",
		app_id: "3001",
		version_code: "22201",
		unix: String(nowMs),
		timezone_offset: String((/* @__PURE__ */ new Date()).getTimezoneOffset() * -60),
		sys_language: lang,
		lang,
		device_id: "0",
		os_name: process.platform,
		browser_name: "mcode",
		user_id: realUserId?.trim() || "0",
		client: "mcode"
	}).toString();
	return url;
}
/** One request to the signed gateway, with the CLI's signature headers. */
async function minimaxAccountCall(region, path, call) {
	const now = Date.now();
	const url = minimaxAccountUrl(region, path, now, call.realUserId);
	const target = `${url.pathname}${url.search}`;
	const body = call.body === void 0 ? "" : JSON.stringify(call.body);
	const seconds = Math.floor(now / 1e3);
	const response = await call.fetchImpl(url, {
		method: call.method ?? "GET",
		redirect: "manual",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"User-Agent": "MiniMaxCode",
			Authorization: `Bearer ${call.token}`,
			yy: minimaxMd5(`${encodeURIComponent(target)}_${body}${minimaxMd5(String(now))}ooui`),
			"x-timestamp": String(seconds),
			"x-signature": minimaxMd5(`${seconds}${MINIMAX_ACCOUNT_SALT}${body}`)
		},
		...body === "" ? {} : { body },
		...call.signal === void 0 ? {} : { signal: call.signal }
	});
	if (redirectTargetsOtherRegion(region, url, response)) {
		rememberRegionAccess(region, true);
		throw new MinimaxRegionBlockedError(region);
	}
	if (response.status >= 300 && response.status < 400) throw new Error(`MiniMax 账号接口返回了意外的重定向（HTTP ${response.status}）。`);
	if (!response.ok) {
		if ((response.status === 401 || response.status === 403) && minimaxRegionBlockedCached(region)) throw new MinimaxRegionBlockedError(region);
		throw new Error(response.status === 401 || response.status === 403 ? "MiniMax 登录已过期：先发一条消息让 CLI 自动续期，或重新登录后再刷新额度。" : `MiniMax 账号接口返回 HTTP ${response.status}。`);
	}
	const payload = asRecord(await response.json());
	if (payload === void 0) throw new Error("MiniMax 账号接口返回了无法解析的响应。");
	const statusInfo = asRecord(payload.statusInfo);
	const statusCode = asNumber(statusInfo?.code);
	if (statusCode !== void 0 && statusCode !== 0) throw new Error(asString(statusInfo?.message) ?? `MiniMax 账号接口错误 ${statusCode}。`);
	const baseResp = asRecord(payload.base_resp);
	const baseCode = asNumber(baseResp?.status_code);
	if (baseCode !== void 0 && baseCode !== 0) throw new Error(asString(baseResp?.status_msg) ?? `MiniMax 账号接口错误 ${baseCode}。`);
	return payload;
}
/**
* Literal characters in a prompt payload; images contribute pixels, not text.
*
* The per-turn input estimate must charge text only, exactly as the Qoder path
* counts a feed, so sending a picture cannot inflate the reported prompt size.
*/
function feedTextLengthOf(prompt) {
	if (prompt === null) return 0;
	if (typeof prompt === "string") return prompt.length;
	return prompt.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}
/** One window's numbers, named the way the coding-plan endpoint reports them. */
function quotaWindow(bucket, kind) {
	const prefix = kind === "interval" ? "current_interval" : "current_weekly";
	const unlimited = asNumber(bucket[`${prefix}_status`]) === 3;
	const percent = asNumber(bucket[`${prefix}_remaining_percent`]);
	const total = asNumber(bucket[`${prefix}_total_count`]);
	const used = asNumber(bucket[`${prefix}_usage_count`]);
	const remaining = percent ?? (total !== void 0 && total > 0 && used !== void 0 ? used / total * 100 : void 0);
	const resetAt = asNumber(bucket[kind === "interval" ? "end_time" : "weekly_end_time"]);
	if (remaining === void 0 && !unlimited && (resetAt === void 0 || resetAt <= 0)) return void 0;
	return {
		...remaining === void 0 || unlimited ? {} : { remainingPercent: Math.round(Math.min(100, Math.max(0, remaining))) },
		...resetAt !== void 0 && resetAt > 0 ? { resetAt } : {},
		unlimited,
		...kind === "interval" && used !== void 0 ? { remainingCount: Math.max(0, used) } : {},
		...kind === "interval" && total !== void 0 ? { totalCount: Math.max(0, total) } : {}
	};
}
/** Turn one `model_remains` bucket into its 5-hour and weekly rows. */
function windowRows(id, label, bucket) {
	const rows = [];
	const interval = quotaWindow(bucket, "interval");
	if (interval !== void 0) rows.push({
		id: `${id}:5h`,
		label: `${label} · 5 小时`,
		...interval
	});
	const weekly = quotaWindow(bucket, "weekly");
	if (weekly !== void 0) rows.push({
		id: `${id}:7d`,
		label: `${label} · 本周`,
		...weekly
	});
	return rows;
}
/** Parse `/v1/api/openplatform/coding_plan/remains`. */
function parseMinimaxRemains(payload) {
	if (payload === void 0) return [];
	const code = asNumber(asRecord(payload.base_resp)?.status_code);
	if (code !== void 0 && code !== 0) return [];
	const buckets = Array.isArray(payload.model_remains) ? payload.model_remains.map(asRecord).filter((bucket) => bucket !== void 0) : [];
	const rows = [];
	const general = buckets[0];
	if (general !== void 0) rows.push(...windowRows("general", "通用", general));
	const video = buckets.find((bucket) => {
		const name = asString(bucket.model_name) ?? "";
		return /video/i.test(name) && (asNumber(bucket.current_interval_total_count) ?? 0) > 0;
	});
	if (video !== void 0) rows.push(...windowRows("video", "视频", video));
	return rows;
}
/**
* Build a snapshot from the three account documents.
*
* Split out from the network path so the mapping is testable without a live
* account: the membership record is the source of the plan and credit
* balance, `remains` only exists for token-plan subscribers.
*/
function minimaxUsageFromParts(parts) {
	const userInfo = parts.userInfo ?? {};
	const membership = parts.membership ?? {};
	const personal = parts.workspaces?.find((workspace) => asNumber(workspace.workspace_type) === 0) ?? parts.workspaces?.[0];
	const name = asString(userInfo.name);
	const email = asString(userInfo.email);
	const avatar = asString(userInfo.avatar);
	const userId = asString(userInfo.userID);
	const account = name === void 0 && email === void 0 && avatar === void 0 && userId === void 0 ? void 0 : {
		...name === void 0 ? {} : { name },
		...email === void 0 ? {} : { email },
		...avatar === void 0 ? {} : { avatar },
		...userId === void 0 ? {} : { userId }
	};
	const summary = asRecord(membership.op_credit_summary) ?? asRecord(personal?.op_credit_summary);
	const remaining = asNumber(summary?.total_remaining_amount) ?? asNumber(personal?.opcredit_balance) ?? asNumber(membership.opcredit_balance);
	const purchased = asNumber(summary?.purchased_remaining_amount);
	const free = asNumber(summary?.free_remaining_amount);
	const credits = remaining === void 0 ? void 0 : {
		remaining,
		...purchased === void 0 ? {} : { purchasedRemaining: purchased },
		...free === void 0 ? {} : { freeRemaining: free }
	};
	const hasTokenPlan = membership.has_token_plan === true || personal?.has_token_plan === true;
	const kind = hasTokenPlan ? "token-plan" : credits !== void 0 && credits.remaining > 0 ? "credits" : "free";
	const planName = asString(membership.plan_name) ?? asString(personal?.plan_name);
	const tier = asString(membership.token_plan_tier) ?? asString(personal?.token_plan_tier);
	const expiresRaw = asNumber(membership.token_plan_expires_at) ?? asNumber(personal?.token_plan_expires_at) ?? asNumber(membership.expires_at);
	const expiresAt = expiresRaw !== void 0 && expiresRaw > 0 ? expiresRaw : void 0;
	const subscriptionType = asString(membership.subscription_type);
	const windows = parseMinimaxRemains(parts.remains);
	return {
		at: parts.at ?? Date.now(),
		region: parts.region,
		signedIn: true,
		installed: parts.installed ?? true,
		...account === void 0 ? {} : { account },
		plan: {
			kind,
			hasTokenPlan,
			...planName === void 0 ? {} : { name: planName },
			...tier === void 0 ? {} : { tier },
			...expiresAt === void 0 ? {} : { expiresAt },
			...subscriptionType === void 0 ? {} : { subscriptionType }
		},
		...credits === void 0 ? {} : { credits },
		...windows.length === 0 ? {} : { windows }
	};
}
/** Read the quota for a token-plan subscriber; a plain account has none. */
async function readMinimaxRemains(region, token, groupId, fetchImpl, signal) {
	const url = new URL("/v1/api/openplatform/coding_plan/remains", MINIMAX_QUOTA_HOSTS[region]);
	const response = await fetchImpl(url, {
		redirect: "manual",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"X-Group-Id": groupId
		},
		signal
	});
	if (redirectTargetsOtherRegion(region, url, response)) {
		rememberRegionAccess(region, true);
		throw new MinimaxRegionBlockedError(region);
	}
	if (response.status >= 300 && response.status < 400) return void 0;
	if (!response.ok) {
		if ((response.status === 401 || response.status === 403) && minimaxRegionBlockedCached(region)) throw new MinimaxRegionBlockedError(region);
		if (response.status === 401 || response.status === 403) throw new Error("MiniMax 登录已过期：先发一条消息让 CLI 自动续期，或重新登录后再刷新额度。");
		return;
	}
	return asRecord(await response.json());
}
const usageCache = /* @__PURE__ */ new Map();
const usageInflight = /* @__PURE__ */ new Map();
/** Drop a cached quota reading, so the next request re-reads it. */
function invalidateMinimaxUsage(region) {
	if (region === void 0) {
		usageCache.clear();
		return;
	}
	usageCache.delete(region);
}
/**
* Read one region's account, plan and quota.
*
* A failed account call keeps the login state and reports the reason in
* `error`; the settings card shows the account it already knows with that
* message instead of silently claiming nothing is configured.
*/
async function minimaxUsage(region, options = {}) {
	const installed = resolveMinimaxCli() !== void 0;
	const token = options.token ?? readStoredToken(region);
	if (!(token !== void 0 || minimaxSignedIn(region))) return {
		at: Date.now(),
		region,
		signedIn: false,
		installed
	};
	if (await minimaxRegionBlocked(region, {
		fresh: options.fresh,
		fetchImpl: options.fetchImpl,
		signal: options.signal
	})) return {
		at: Date.now(),
		region,
		signedIn: true,
		installed,
		regionBlocked: true,
		error: minimaxRegionBlockMessage(region)
	};
	if (token === void 0) return {
		at: Date.now(),
		region,
		signedIn: true,
		installed,
		error: "未找到 MiniMax 登录凭据，请重新登录。"
	};
	if (options.token === void 0 && options.fresh !== true) {
		const cached = usageCache.get(region);
		if (cached !== void 0 && Date.now() - cached.at < 6e4) return cached.snapshot;
	}
	let pending = usageInflight.get(region);
	if (pending === void 0) {
		pending = readUsage(region, token, installed, options).finally(() => {
			usageInflight.delete(region);
		});
		usageInflight.set(region, pending);
	}
	const snapshot = await pending;
	if (snapshot.error === void 0 && options.token === void 0) usageCache.set(region, {
		at: snapshot.at,
		snapshot
	});
	return snapshot;
}
async function readUsage(region, token, installed, options) {
	const timeout = AbortSignal.timeout(MINIMAX_USAGE_TIMEOUT_MS);
	const signal = options.signal === void 0 ? timeout : AbortSignal.any([options.signal, timeout]);
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const info = await minimaxAccountCall(region, "/v1/api/user/info", {
			token,
			fetchImpl,
			signal
		});
		const userInfo = asRecord(asRecord(info.data)?.userInfo) ?? asRecord(info.userInfo) ?? {};
		const realUserId = asString(userInfo.realUserID) ?? asString(userInfo.real_user_id);
		const extra = await minimaxAccountCall(region, "/matrix/api/v1/user/get_user_extra_info", {
			method: "POST",
			body: {},
			realUserId,
			token,
			fetchImpl,
			signal
		});
		const workspaces = (Array.isArray(extra.workspaces) ? extra.workspaces : Array.isArray(asRecord(extra.data)?.workspaces) ? asRecord(extra.data)?.workspaces : []).map(asRecord).filter((workspace) => workspace !== void 0);
		const personal = workspaces.find((workspace) => asNumber(workspace.workspace_type) === 0) ?? workspaces[0];
		const workspaceId = asNumber(personal?.workspace_id);
		const membership = workspaceId === void 0 ? {} : await minimaxAccountCall(region, "/matrix/api/v1/commerce/get_membership_info", {
			method: "POST",
			body: { workspace_id: workspaceId },
			realUserId,
			token,
			fetchImpl,
			signal
		});
		const groupId = asString(membership.op_group_id) ?? asString(personal?.op_group_id);
		return minimaxUsageFromParts({
			region,
			installed,
			userInfo,
			workspaces,
			membership,
			remains: (membership.has_token_plan === true || personal?.has_token_plan === true) && groupId !== void 0 ? await readMinimaxRemains(region, token, groupId, fetchImpl, signal) : void 0
		});
	} catch (error) {
		const blocked = error instanceof MinimaxRegionBlockedError;
		return {
			at: Date.now(),
			region,
			signedIn: true,
			installed,
			...blocked ? { regionBlocked: true } : {},
			error: blocked ? minimaxRegionBlockMessage(region) : error instanceof Error ? error.message : String(error)
		};
	}
}
/** Trim CLI output to a short, token-free sentence. */
function outputTail(lines) {
	return lines.slice(-4).map((line) => line.replace(/mmo(at|rt)_[A-Za-z0-9_-]+/g, "mmo***")).join(" ").slice(0, 400);
}
/**
* Browser login/logout, one run per region.
*
* The CLI owns the OAuth device flow and the credential file. The plugin only
* starts the process, surfaces the authorization URL while it waits, and then
* re-reads the auth-state file to decide whether the region is signed in.
*/
var MinimaxAuth = class {
	runs = /* @__PURE__ */ new Map();
	status(region) {
		const run = this.runs.get(region);
		if (run !== void 0) return run.status;
		const state = readAuthState(region);
		return {
			running: false,
			region,
			signedIn: state?.status === "authenticated",
			...state?.expiresAtMs === void 0 ? {} : { expiresAt: state.expiresAtMs }
		};
	}
	/** Start the CLI's browser login. */
	start(region, onFinish) {
		const existing = this.runs.get(region);
		if (existing !== void 0 && existing.status.running) return {
			started: false,
			error: "该区域正在登录，请先在浏览器中完成授权。"
		};
		const spec = resolveMinimaxCli();
		if (spec === void 0) return {
			started: false,
			error: "未安装 MiniMax Code CLI（mcode），请先安装后再登录。"
		};
		const status = {
			running: true,
			region,
			signedIn: false,
			startedAt: Date.now()
		};
		const run = {
			status,
			child: void 0,
			lines: [],
			finish: (_code) => {}
		};
		const env = {
			...process.env,
			MAVIS_REGION: minimaxCliRegion(region)
		};
		delete env.MAVIS_AGENT;
		delete env.MAVIS_SESSION;
		const child = spawn(spec.command, minimaxCliArgs(spec, [
			"login",
			"--region",
			region === "cn" ? "cn" : "global"
		]), {
			cwd: homedir(),
			env,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		run.child = child;
		this.runs.set(region, run);
		const absorb = (chunk) => {
			const text = String(chunk);
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				run.lines.push(trimmed);
				const match = /^(?:Open:\s*)?(https?:\/\/\S+)/.exec(trimmed);
				if (match !== null) status.url = match[1];
			}
			while (run.lines.length > 40) run.lines.shift();
		};
		child.stdout?.on("data", absorb);
		child.stderr?.on("data", absorb);
		const finish = (code) => {
			if (!status.running) return;
			status.running = false;
			status.finishedAt = Date.now();
			const state = readAuthState(region);
			status.signedIn = state?.status === "authenticated";
			if (state?.expiresAtMs !== void 0) status.expiresAt = state.expiresAtMs;
			if (code !== 0) status.error = outputTail(run.lines) || "登录未完成";
			else if (!status.signedIn) status.error = outputTail(run.lines) || "登录未完成";
			try {
				onFinish?.(status.signedIn);
			} catch {}
		};
		run.finish = finish;
		child.on("error", (error) => {
			status.error = `无法启动 mcode：${error.message}`;
			finish(null);
		});
		child.on("close", (code) => {
			finish(code);
		});
		return { started: true };
	}
	/** Sign one region out; the other region is untouched. */
	async logout(region) {
		const spec = resolveMinimaxCli();
		if (spec === void 0) return {
			running: false,
			region,
			signedIn: false,
			error: "未安装 MiniMax Code CLI（mcode）。"
		};
		const env = {
			...process.env,
			MAVIS_REGION: minimaxCliRegion(region)
		};
		delete env.MAVIS_AGENT;
		delete env.MAVIS_SESSION;
		const result = await new Promise((resolve) => {
			const lines = [];
			const child = spawn(spec.command, minimaxCliArgs(spec, [
				"logout",
				"--region",
				region === "cn" ? "cn" : "global"
			]), {
				cwd: homedir(),
				env,
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
			const absorb = (chunk) => {
				for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== "") lines.push(line.trim());
				while (lines.length > 40) lines.shift();
			};
			child.stdout?.on("data", absorb);
			child.stderr?.on("data", absorb);
			const timer = setTimeout(() => {
				child.kill();
				resolve({
					code: null,
					lines
				});
			}, 2e4);
			child.on("error", () => {
				clearTimeout(timer);
				resolve({
					code: null,
					lines
				});
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({
					code,
					lines
				});
			});
		});
		this.runs.delete(region);
		const state = readAuthState(region);
		return {
			running: false,
			region,
			signedIn: state?.status === "authenticated",
			...state?.expiresAtMs === void 0 ? {} : { expiresAt: state.expiresAtMs },
			...result.code !== 0 ? { error: outputTail(result.lines) || "退出登录未完成" } : {}
		};
	}
	/** Cancel any login process (plugin disposal). */
	stop() {
		for (const run of this.runs.values()) if (run.status.running) run.child.kill();
	}
};
/** A single-consumer async event queue. */
var EventQueue = class {
	items = [];
	waiter = null;
	closed = false;
	push(event) {
		if (this.closed) return;
		if (this.waiter !== null) {
			const settle = this.waiter;
			this.waiter = null;
			settle(event);
			return;
		}
		this.items.push(event);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		if (this.waiter !== null) {
			const settle = this.waiter;
			this.waiter = null;
			settle(void 0);
		}
	}
	get isClosed() {
		return this.closed;
	}
	next() {
		const item = this.items.shift();
		if (item !== void 0) return Promise.resolve(item);
		if (this.closed) return Promise.resolve(void 0);
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}
};
/** Render a harness tool result for the MCP caller. */
function renderToolResult(content) {
	const text = (value) => {
		if (typeof value === "string") return value;
		if (value === null || value === void 0) return "";
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	};
	if (Array.isArray(content)) {
		const parts = [];
		for (const block of content) {
			if (typeof block === "string") {
				parts.push(block);
				continue;
			}
			if (block !== null && typeof block === "object" && block.type === "text") {
				parts.push(text(block.text));
				continue;
			}
			parts.push(text(block));
		}
		const joined = parts.join("\n").trim();
		return { content: [{
			type: "text",
			text: joined === "" ? "（宿主工具没有返回内容）" : joined
		}] };
	}
	const joined = text(content).trim();
	return { content: [{
		type: "text",
		text: joined === "" ? "（宿主工具没有返回内容）" : joined
	}] };
}
/**
* One `mcode acp` process and its ACP session.
*
* The class only speaks protocol: model/effort config, prompts, cancellation,
* and the translation of `session/update` into {@link SessionEvent}s. Turn
* policy (tool calls, retries, harness chunks) lives in {@link MinimaxSession}.
*/
var MinimaxAcp = class {
	child = null;
	conn = null;
	sessionId;
	configOptions = [];
	systemFile;
	tempDir;
	closing = false;
	stderr = [];
	options;
	constructor(options) {
		this.options = options;
	}
	/** The model/effort options the CLI currently offers. */
	get optionsList() {
		return this.configOptions;
	}
	/** The selected model config value. */
	get currentModel() {
		const option = this.configOptions.find((entry) => entry?.category === "model" || entry?.id === "model");
		return typeof option?.currentValue === "string" ? option.currentValue : void 0;
	}
	/** Start the process and create one ACP session. */
	async start() {
		const spec = resolveMinimaxCli();
		if (spec === void 0) throw new Error("未安装 MiniMax Code CLI（mcode）。请在设置页安装，或运行 npm install -g @minimax-ai/code。");
		const timeout = this.options.timeoutMs ?? 3e4;
		const directory = mkdtempSync(join(tmpdir(), "dsh-minimax-acp-"));
		const systemFile = join(directory, "system.md");
		writeFileSync(systemFile, this.options.systemPrompt, "utf8");
		this.systemFile = systemFile;
		this.tempDir = directory;
		const env = {
			...process.env,
			MAVIS_REGION: minimaxCliRegion(this.options.region),
			...this.options.disableTools === true ? { MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS: "1" } : {}
		};
		delete env.MAVIS_AGENT;
		delete env.MAVIS_SESSION;
		const child = spawn(spec.command, minimaxCliArgs(spec, [
			"acp",
			"--system-prompt-file",
			systemFile
		]), {
			cwd: this.options.cwd,
			env,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.child = child;
		child.stderr?.on("data", (chunk) => {
			for (const line of String(chunk).split(/\r?\n/)) if (line.trim() !== "") this.stderr.push(line.trim());
			while (this.stderr.length > 30) this.stderr.shift();
		});
		child.on("exit", (code, signal) => {
			if (this.closing) return;
			const detail = outputTail(this.stderr) || `mcode acp 退出（code=${String(code)}, signal=${String(signal)}）`;
			this.options.onExit?.(new Error(detail));
		});
		if (child.stdin === null || child.stdout === null) throw new Error("mcode acp 没有可用的 stdio。");
		const client = {
			sessionUpdate: (params) => {
				if (params.sessionId !== void 0 && this.sessionId !== void 0 && params.sessionId !== this.sessionId) return;
				const update = params.update;
				if (update === null || typeof update !== "object") return;
				switch (update.sessionUpdate) {
					case "agent_message_chunk": {
						const text = typeof update.content?.text === "string" ? update.content.text : "";
						if (text.length > 0) this.options.onUpdate?.({
							kind: "text",
							text
						});
						return;
					}
					case "agent_thought_chunk": {
						const text = typeof update.content?.text === "string" ? update.content.text : "";
						if (text.length > 0) this.options.onUpdate?.({
							kind: "reasoning",
							text
						});
						return;
					}
					case "usage_update": {
						const used = typeof update.used === "number" ? update.used : 0;
						const size = typeof update.size === "number" ? update.size : 0;
						if (size > 0) this.options.onUpdate?.({
							kind: "usage",
							used,
							size
						});
						return;
					}
					case "tool_call":
					case "tool_call_update": {
						const name = typeof update.title === "string" && update.title.length > 0 ? update.title : typeof update.name === "string" ? update.name : "";
						if (name.length === 0) return;
						if (!isHostMcpTool(name)) {
							if (update.sessionUpdate === "tool_call" || update.status === "in_progress") this.options.onUpdate?.({
								kind: "native-tool",
								name
							});
							return;
						}
						return;
					}
					default: return;
				}
			},
			requestPermission: async (params) => {
				const name = typeof params?.toolCall?.title === "string" && params.toolCall.title.length > 0 ? params.toolCall.title : typeof params?.toolCall?.name === "string" ? params.toolCall.name : "";
				const options = Array.isArray(params?.options) ? params.options : [];
				if (isHostMcpTool(name)) {
					const allow = options.find((entry) => entry?.kind === "allow_once") ?? options.find((entry) => entry?.kind === "allow_always") ?? options[0];
					if (allow !== void 0) return { outcome: {
						outcome: "selected",
						optionId: allow.optionId
					} };
					return { outcome: { outcome: "cancelled" } };
				}
				this.options.onPermissionDenied?.(name);
				const deny = options.find((entry) => entry?.kind === "reject_once") ?? options.find((entry) => entry?.kind === "reject_always");
				return deny === void 0 ? { outcome: { outcome: "cancelled" } } : { outcome: {
					outcome: "selected",
					optionId: deny.optionId
				} };
			}
		};
		const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
		const conn = new ClientSideConnection(() => client, stream);
		this.conn = conn;
		await withTimeout(conn.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: {
					readTextFile: false,
					writeTextFile: false
				},
				terminal: false
			},
			clientInfo: {
				name: "dsh-agent-sdk-bridge",
				version: "1.1.0"
			}
		}), timeout, "mcode acp initialize");
		const mcpServers = this.options.mcpUrl === void 0 ? [] : [{
			type: "http",
			name: MINIMAX_MCP_SERVER,
			url: this.options.mcpUrl,
			headers: [{
				name: "Authorization",
				value: `Bearer ${this.options.mcpToken ?? ""}`
			}]
		}];
		const session = await withTimeout(conn.newSession({
			cwd: this.options.cwd,
			mcpServers
		}), timeout, "mcode acp session/new");
		this.sessionId = session.sessionId;
		this.configOptions = Array.isArray(session.configOptions) ? [...session.configOptions] : [];
	}
	/**
	* Run one prompt; resolves when the agent's turn ends.
	*
	* ACP carries images as `{ type: 'image', data, mimeType }` blocks next to
	* text, which is what makes a pasted picture reach the model at all; a plain
	* string keeps the historical text-only shape.
	*/
	async prompt(prompt) {
		if (this.conn === null || this.sessionId === void 0) throw new Error("ACP 会话尚未启动。");
		const blocks = typeof prompt === "string" ? [{
			type: "text",
			text: prompt
		}] : [...prompt];
		const response = await this.conn.prompt({
			sessionId: this.sessionId,
			prompt: blocks
		});
		return { stopReason: String(response.stopReason) };
	}
	/** Ask the agent to stop the active turn. */
	async cancel() {
		if (this.conn === null || this.sessionId === void 0) return;
		try {
			await this.conn.cancel({ sessionId: this.sessionId });
		} catch {}
	}
	/** Set a session config option and remember the updated list. */
	async setConfig(id, value) {
		if (this.conn === null || this.sessionId === void 0) return;
		const option = this.configOptions.find((entry) => entry?.id === id);
		if (option === void 0) return;
		if (option.currentValue === value) return;
		if (!(Array.isArray(option.options) ? option.options.some((entry) => entry?.value === value) : true)) return;
		const response = await this.conn.setSessionConfigOption({
			sessionId: this.sessionId,
			configId: id,
			value
		});
		if (Array.isArray(response.configOptions)) this.configOptions = [...response.configOptions];
	}
	/**
	* List the models the CLI actually accepts, with each model's own efforts.
	*
	* The advertised option list can contain values the agent rejects (0.6.12
	* lists a `M3.1-Flash` non-thinking value and answers `Invalid model
	* reasoning` when it is selected). Selecting each value once is the only
	* reliable filter, and it also reveals that non-thinking models drop the
	* `thinkingEffort` option entirely, so reasoning has to be reported per
	* model rather than once for the catalog.
	*/
	async probeModels() {
		const modelOption = this.configOptions.find((entry) => entry?.category === "model" || entry?.id === "model");
		if (!Array.isArray(modelOption?.options)) return [];
		const initial = typeof modelOption.currentValue === "string" ? modelOption.currentValue : void 0;
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const entry of modelOption.options) {
			if (typeof entry?.value !== "string" || entry.value.length === 0 || seen.has(entry.value)) continue;
			seen.add(entry.value);
			try {
				await this.setConfig(String(modelOption.id), entry.value);
			} catch {
				continue;
			}
			const row = modelRow(entry, effortValues(this.configOptions.find((option) => option?.id === "thinkingEffort" || option?.category === "thought_level")?.options));
			if (row !== void 0) models.push(row);
		}
		if (initial !== void 0 && this.currentModel !== initial) try {
			await this.setConfig(String(modelOption.id), initial);
		} catch {}
		return models;
	}
	/** Select the model (and, when supported, the thinking effort). */
	async selectModel(model, effort) {
		const modelOption = this.configOptions.find((entry) => entry?.category === "model" || entry?.id === "model");
		if (modelOption !== void 0) {
			if ((Array.isArray(modelOption.options) ? modelOption.options.map((entry) => entry?.value) : []).includes(model)) await this.setConfig(String(modelOption.id), model);
		}
		if (effort !== void 0 && effort.length > 0 && effort !== "default") {
			const effortOption = this.configOptions.find((entry) => entry?.id === "thinkingEffort" || entry?.category === "thought_level");
			if (effortOption !== void 0) try {
				await this.setConfig(String(effortOption.id), effort);
			} catch {}
		}
	}
	/** Exit the session and reap the process. */
	async close() {
		if (this.closing) return;
		this.closing = true;
		const conn = this.conn;
		const sessionId = this.sessionId;
		this.conn = null;
		this.sessionId = void 0;
		if (conn !== null && sessionId !== void 0) await withTimeout(conn.closeSession({ sessionId }), 3e3, "mcode acp session/close").catch(() => void 0);
		this.child?.kill();
		this.child = null;
		if (this.tempDir !== void 0) {
			try {
				rmSync(this.tempDir, {
					recursive: true,
					force: true
				});
			} catch {}
			this.tempDir = void 0;
		}
		this.systemFile = void 0;
	}
};
/** A one-shot ACP process used by the catalog and title side channels. */
async function withAcp(region, timeoutMs, run, options = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "dsh-minimax-side-"));
	const acp = new MinimaxAcp({
		region,
		cwd,
		systemPrompt: options.systemPrompt ?? "You are a helper. Do not use tools.",
		disableTools: options.disableTools ?? true,
		timeoutMs
	});
	try {
		await acp.start();
		return await run(acp);
	} finally {
		await acp.close();
		try {
			rmSync(cwd, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
/** Read the model list for one region (cached). */
var MinimaxCatalog = class {
	region;
	ttlMs;
	timeoutMs;
	snapshots = /* @__PURE__ */ new Map();
	inflight = /* @__PURE__ */ new Map();
	failures = /* @__PURE__ */ new Map();
	constructor(region, ttlMs = MINIMAX_CACHE_TTL_MS, timeoutMs = MINIMAX_FETCH_TIMEOUT_MS) {
		this.region = region;
		this.ttlMs = ttlMs;
		this.timeoutMs = timeoutMs;
	}
	/** Models for one region; a failed refresh keeps the last good list. */
	async models(requested) {
		const region = requested ?? readLive(this.region, "cn");
		if (await minimaxRegionBlocked(region)) {
			this.invalidate(region);
			return [];
		}
		const ttl = readLive(this.ttlMs, MINIMAX_CACHE_TTL_MS);
		const cached = this.snapshots.get(region);
		if (cached !== void 0 && Date.now() - cached.at < ttl) return cached.models;
		let pending = this.inflight.get(region);
		if (pending === void 0) {
			pending = this.fetch(region).finally(() => {
				this.inflight.delete(region);
			});
			this.inflight.set(region, pending);
		}
		try {
			const models = await pending;
			this.snapshots.set(region, {
				at: Date.now(),
				models
			});
			this.failures.delete(region);
			return models;
		} catch (error) {
			this.failures.set(region, error instanceof Error ? error.message : String(error));
			return cached?.models ?? [];
		}
	}
	/**
	* The last successful list for a region, without probing.
	*
	* The picker resolves a route on every switch; awaiting an ACP probe there
	* cost a process round-trip whenever the TTL had just expired.
	*/
	snapshot(requested) {
		return this.snapshots.get(requested ?? readLive(this.region, "cn"))?.models;
	}
	/** Why the last refresh failed, or undefined when it succeeded. */
	error(requested) {
		return this.failures.get(requested ?? readLive(this.region, "cn"));
	}
	invalidate(region) {
		if (region === void 0) {
			this.snapshots.clear();
			this.failures.clear();
			return;
		}
		this.snapshots.delete(region);
		this.failures.delete(region);
	}
	async fetch(region) {
		if (!minimaxSignedIn(region)) throw new Error(`${region === "cn" ? "MiniMax 国内站" : "MiniMax 国际站"}尚未登录，请先在设置页登录。`);
		if (await minimaxRegionBlocked(region)) throw new MinimaxRegionBlockedError(region);
		return await withAcp(region, readLive(this.timeoutMs, MINIMAX_FETCH_TIMEOUT_MS), async (acp) => acp.probeModels(), {
			systemPrompt: "You are a helper used only to list models. Do not call any tool.",
			disableTools: true
		});
	}
};
/** One shared HTTP MCP server for every warm MiniMax session. */
var MinimaxMcpServer = class {
	server;
	port = 0;
	bridges = /* @__PURE__ */ new Map();
	/** The base URL, or undefined before {@link start}. */
	get baseUrl() {
		return this.server === void 0 ? void 0 : `http://127.0.0.1:${this.port}`;
	}
	/** Bind to an ephemeral loopback port. */
	async start() {
		if (this.server !== void 0) return;
		const server = createServer((req, res) => {
			this.handle(req, res);
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") {
			server.close();
			throw new Error("无法为 MiniMax 宿主工具分配本地端口。");
		}
		this.port = address.port;
		this.server = server;
	}
	/** Add one session's bridge under a random token. */
	register(bridge) {
		if (this.server === void 0) throw new Error("MiniMax MCP server 尚未启动。");
		const token = randomBytes(24).toString("hex");
		this.bridges.set(token, bridge);
		return {
			url: `${this.baseUrl}/mcp/${token}`,
			token
		};
	}
	unregister(token) {
		this.bridges.delete(token);
	}
	/** Close the server and release every session. */
	close() {
		this.bridges.clear();
		this.server?.close();
		this.server = void 0;
	}
	async handle(req, res) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const match = /^\/mcp\/([a-f0-9]+)$/.exec(url.pathname);
		const bridge = match === null ? void 0 : this.bridges.get(match[1]);
		if (bridge === void 0) {
			res.writeHead(404, { "content-type": "application/json" }).end("{\"error\":\"unknown MCP session\"}");
			return;
		}
		if (req.method === "GET") {
			res.writeHead(405).end();
			return;
		}
		if (req.method === "DELETE") {
			res.writeHead(200).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		if (req.headers.authorization !== `Bearer ${match?.[1] ?? ""}`) {
			res.writeHead(403).end();
			return;
		}
		let raw = "";
		for await (const chunk of req) {
			raw += chunk;
			if (raw.length > 8388608) {
				res.writeHead(413).end();
				return;
			}
		}
		let message;
		try {
			message = JSON.parse(raw);
		} catch {
			res.writeHead(400).end();
			return;
		}
		const id = message?.id;
		const reply = (payload) => {
			const body = JSON.stringify(payload);
			res.writeHead(200, {
				"content-type": "application/json",
				"mcp-session-id": match?.[1] ?? "dsh-host"
			}).end(body);
		};
		if (message?.method === void 0) {
			res.writeHead(202).end();
			return;
		}
		if (id === void 0) {
			res.writeHead(202).end();
			return;
		}
		try {
			switch (message.method) {
				case "initialize":
					reply({
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: {
								name: MINIMAX_MCP_SERVER,
								version: "1.0.0"
							}
						}
					});
					return;
				case "ping":
					reply({
						jsonrpc: "2.0",
						id,
						result: {}
					});
					return;
				case "tools/list":
					reply({
						jsonrpc: "2.0",
						id,
						result: { tools: bridge.tools() }
					});
					return;
				case "tools/call": {
					const name = typeof message.params?.name === "string" ? message.params.name : "";
					const args = message.params?.arguments !== null && typeof message.params?.arguments === "object" ? message.params.arguments : {};
					reply({
						jsonrpc: "2.0",
						id,
						result: await bridge.call(name, args)
					});
					return;
				}
				default:
					reply({
						jsonrpc: "2.0",
						id,
						error: {
							code: -32601,
							message: `Unknown method ${String(message.method)}`
						}
					});
					return;
			}
		} catch (error) {
			reply({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{
						type: "text",
						text: error instanceof Error ? error.message : String(error)
					}],
					isError: true
				}
			});
		}
	}
};
/** One session's view of the MCP server. */
var MinimaxMcpBridge = class {
	callHost;
	schemas = [];
	constructor(callHost) {
		this.callHost = callHost;
	}
	setTools(tools) {
		this.schemas = tools;
	}
	tools() {
		return this.schemas.map((schema) => ({
			name: schema.name,
			description: schema.description.length > 0 ? schema.description : schema.name,
			inputSchema: schema.parameters !== null && typeof schema.parameters === "object" ? schema.parameters : {
				type: "object",
				properties: {}
			}
		}));
	}
	async call(name, args) {
		if (!this.schemas.some((schema) => schema.name === name)) return {
			content: [{
				type: "text",
				text: `未知工具：${name}`
			}],
			isError: true
		};
		return await this.callHost(name, args);
	}
};
/**
* Round one token count up to a whole number.
*
* The harness validates every usage bucket as `number().int().nonnegative()`.
* The text estimator prices by script and therefore returns fractions; a
* fractional reading is accepted when it streams but makes the durable usage
* projection fail, and the conversation then refuses to load at all (the
* "failed to project session" error). Counts must leave this module whole.
*/
function wholeTokens(value) {
	return Math.max(1, Math.ceil(value));
}
/** Build a turn's usage from its character counts and the reported context. */
function minimaxTurnUsage(counts) {
	const inputTokens = wholeTokens(counts.contextUsed ?? estimateTextTokens(counts.inputChars, 0));
	const outputTokens = wholeTokens(estimateTextTokens(counts.outputChars + counts.reasoningChars, 0));
	const reasoningTokens = counts.reasoningChars === 0 ? void 0 : Math.min(outputTokens, wholeTokens(estimateTextTokens(counts.reasoningChars, 0)));
	return {
		inputTokens,
		outputTokens,
		...reasoningTokens === void 0 ? {} : { reasoningTokens },
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: inputTokens + outputTokens
	};
}
/** A prompt that asks the model to retry without native tools. */
const NATIVE_TOOL_CORRECTION = [
	"SYSTEM NOTICE (not from the user):",
	"The built-in tools (bash, read, write, edit, glob, grep, web_fetch, task, and every other native tool)",
	"are disabled in this deployment. Any call to them is cancelled before execution.",
	"The only valid tools are the host MCP tools whose names begin with mcp__dsh-host__.",
	"Re-answer the user's last request using only those host tools. Do not mention this notice."
].join("\n");
/** The tool policy appended to the host system prompt. */
const HOST_TOOL_POLICY = [
	"## Host tool protocol",
	"You are the model backend of DeepSeek Harness.",
	"The ONLY tools you may call are the host MCP tools exposed by the `dsh-host` MCP server;",
	"their names begin with `mcp__dsh-host__`. The built-in tools (bash, read, write, edit, glob,",
	"grep, web_fetch, task, and every other native tool) are disabled in this deployment: calling",
	"one aborts the turn before execution. Never mention this rule to the user."
].join("\n");
/**
* One warm MiniMax conversation for a harness session id.
*
* The ACP agent owns the history. A turn ends either when the prompt finishes
* or when a host tool call is handed to the harness; in the latter case the
* ACP prompt stays open until the harness returns the result on its next
* request, exactly like the CodeBuddy bridge.
*/
var MinimaxSession = class {
	sessionId;
	mcpServer;
	acp = null;
	events = new EventQueue();
	bridge;
	pending = /* @__PURE__ */ new Map();
	toolResultTimeoutMs;
	abortGraceMs;
	callNonce = randomUUID().slice(0, 8);
	toolCounter = 0;
	promptInFlight = false;
	activeTurn = false;
	disposed = false;
	region = "cn";
	model = "";
	effort;
	systemPrompt = "";
	workspace;
	/** The harness workspace; absent means the session owns a temp directory. */
	requestedCwd;
	ownsWorkspace = false;
	mcpToken;
	toolSchemas = [];
	nativeViolation = false;
	cancelSent = false;
	correctionCount = 0;
	observedContextWindow;
	/** Was the last turn closed with tool-calls, leaving the ACP prompt open? */
	awaitingToolResults = false;
	/** Host messages already fed to the ACP session, for continuation planning. */
	fedMessages;
	/** Host system prompt last applied; informational for the adapter. */
	fedSystem;
	constructor(sessionId, initialModel, mcpServer, runtime = {}) {
		this.sessionId = sessionId;
		this.mcpServer = mcpServer;
		this.model = initialModel;
		this.toolResultTimeoutMs = readLive(runtime.toolResultTimeoutMs, 12e4);
		this.abortGraceMs = readLive(runtime.abortGraceMs, 5e3);
		this.bridge = new MinimaxMcpBridge((name, args) => this.handleToolCall(name, args));
	}
	/** Model context window observed from a real turn, when one was reported. */
	get contextWindow() {
		return this.observedContextWindow;
	}
	/**
	* Whether the ACP session still owns an unfinished turn.
	*
	* A turn closed with `tool-calls` keeps its prompt open while the host runs
	* the tools, so this stays true between the two host requests. A brand-new
	* user message in that state cannot be injected; the adapter rebuilds the
	* session and feeds the whole history instead.
	*/
	get busy() {
		return this.promptInFlight || this.activeTurn;
	}
	/**
	* Point the session at a region, model and system prompt.
	*
	* @returns true when the warm ACP process was dropped, which means the
	* conversation state must be rebuilt from the durable history.
	*/
	configure(region, model, options = {}) {
		const nextSystem = options.system ?? "";
		const nextCwd = options.cwd;
		let reset = false;
		if (this.acp !== null && (nextSystem !== this.systemPrompt || region !== this.region || nextCwd !== this.requestedCwd)) {
			this.dropAcp();
			this.fedMessages = void 0;
			reset = true;
		}
		this.region = region;
		this.model = model;
		this.effort = options.effort;
		this.systemPrompt = nextSystem;
		this.requestedCwd = nextCwd;
		return reset;
	}
	/** Register the host tools this session's MCP server advertises. */
	ensureTools(tools) {
		this.toolSchemas = tools;
		this.bridge.setTools(tools);
	}
	/** Hand the host's tool results to parked handlers. */
	deliverToolResults(tail) {
		let freshUserTurn = false;
		for (const message of tail) {
			if (message.role === "user") {
				freshUserTurn = true;
				continue;
			}
			if (message.role !== "tool") continue;
			const callId = message.toolCallId === void 0 ? "" : String(message.toolCallId);
			const pending = this.pending.get(callId);
			if (pending === void 0) continue;
			clearTimeout(pending.timer);
			this.pending.delete(callId);
			pending.resolve({
				...renderToolResult(message.content),
				...message.isError === true ? { isError: true } : {}
			});
		}
		if (freshUserTurn && this.pending.size > 0) {
			for (const [callId, pending] of this.pending) {
				clearTimeout(pending.timer);
				pending.reject(/* @__PURE__ */ new Error("宿主开始了新的用户轮次，未返回的工具结果已取消。"));
				this.pending.delete(callId);
			}
			if (this.promptInFlight) this.acp?.cancel();
			this.awaitingToolResults = false;
		}
	}
	/** Run one harness turn. `feed` is new user content, or null for a continuation. */
	async *stream(options, feed) {
		if (this.disposed) throw new Error(`MiniMax session ${this.sessionId} was disposed`);
		if (this.activeTurn) throw new Error(`MiniMax session ${this.sessionId} already has a turn in flight`);
		this.activeTurn = true;
		const signal = options.signal;
		const turn = {
			blockIndex: 0,
			inputChars: feedTextLengthOf(feed),
			outputChars: 0,
			reasoningChars: 0
		};
		let abortRequested = false;
		let abortTimer;
		let onAbortListener;
		try {
			await this.ensureStarted();
			if (!this.promptInFlight) {
				await this.startPrompt(feed ?? "");
				this.awaitingToolResults = false;
			} else if (feed !== null && feedTextLengthOf(feed) > 0 && !this.awaitingToolResults) throw new Error("MiniMax 会话正忙：上一轮尚未结束。");
			const onAbort = () => {
				abortRequested = true;
				this.acp?.cancel();
				abortTimer = setTimeout(() => {
					this.dropAcp();
				}, this.abortGraceMs);
			};
			onAbortListener = onAbort;
			signal?.addEventListener("abort", onAbort, { once: true });
			while (true) {
				if (signal?.aborted === true) {
					if (!abortRequested) onAbort();
					rejectPending(this.pending, /* @__PURE__ */ new Error("MiniMax 会话被宿主中止。"));
					this.promptInFlight = false;
					this.awaitingToolResults = false;
					yield* this.finish(turn, {
						kind: "aborted",
						failure: {
							message: "MiniMax turn aborted by host",
							code: "ABORTED"
						}
					});
					return;
				}
				const event = await raceAbort(this.events.next(), signal);
				if (event === void 0) {
					if (abortRequested) continue;
					yield* this.finish(turn, {
						kind: "error",
						failure: {
							message: "MiniMax ACP stream closed",
							code: "STREAM_CLOSED"
						}
					});
					return;
				}
				switch (event.kind) {
					case "text":
						turn.outputChars += event.text.length;
						if (turn.textBlock === void 0) {
							turn.textBlock = {
								index: turn.blockIndex++,
								text: ""
							};
							yield {
								type: "block-start",
								index: turn.textBlock.index,
								blockType: "text"
							};
						}
						turn.textBlock.text += event.text;
						yield {
							type: "text-delta",
							index: turn.textBlock.index,
							text: event.text
						};
						continue;
					case "reasoning":
						turn.reasoningChars += event.text.length;
						if (turn.reasoningBlock === void 0) {
							turn.reasoningBlock = {
								index: turn.blockIndex++,
								text: ""
							};
							yield {
								type: "block-start",
								index: turn.reasoningBlock.index,
								blockType: "reasoning"
							};
						}
						turn.reasoningBlock.text += event.text;
						yield {
							type: "reasoning-delta",
							index: turn.reasoningBlock.index,
							text: event.text
						};
						continue;
					case "usage":
						if (event.size > 0) this.observedContextWindow = event.size;
						if (event.used > 0) turn.contextUsed = event.used;
						continue;
					case "host-tool": {
						if (turn.textBlock !== void 0) {
							yield {
								type: "block-end",
								index: turn.textBlock.index,
								block: {
									type: "text",
									text: turn.textBlock.text
								}
							};
							turn.textBlock = void 0;
						}
						if (turn.reasoningBlock !== void 0) {
							yield {
								type: "block-end",
								index: turn.reasoningBlock.index,
								block: {
									type: "reasoning",
									text: turn.reasoningBlock.text
								}
							};
							turn.reasoningBlock = void 0;
						}
						const index = turn.blockIndex++;
						yield {
							type: "block-start",
							index,
							blockType: "tool-call"
						};
						const args = JSON.stringify(event.args);
						yield {
							type: "tool-call-delta",
							index,
							id: ToolCallId(event.callId),
							name: event.name,
							argumentsDelta: args
						};
						yield {
							type: "block-end",
							index,
							block: {
								type: "tool-call",
								id: ToolCallId(event.callId),
								name: event.name,
								arguments: args
							}
						};
						this.awaitingToolResults = true;
						yield* this.finish(turn, { kind: "tool-calls" });
						return;
					}
					case "native-tool":
						if (!this.cancelSent) {
							this.cancelSent = true;
							this.nativeViolation = true;
							await this.acp?.cancel();
						}
						continue;
					case "prompt-done":
						this.promptInFlight = false;
						this.cancelSent = false;
						if (abortRequested) {
							rejectPending(this.pending, /* @__PURE__ */ new Error("MiniMax 会话被宿主中止。"));
							yield* this.finish(turn, {
								kind: "aborted",
								failure: {
									message: "MiniMax turn aborted by host",
									code: "ABORTED"
								}
							});
							return;
						}
						if (this.nativeViolation) {
							this.nativeViolation = false;
							this.correctionCount += 1;
							if (this.correctionCount <= MAX_NATIVE_TOOL_RETRIES) {
								await new Promise((resolve) => setTimeout(resolve, 350));
								try {
									await this.startPrompt(NATIVE_TOOL_CORRECTION);
									this.awaitingToolResults = false;
									continue;
								} catch (error) {
									yield* this.finish(turn, {
										kind: "error",
										failure: {
											message: `MiniMax 内置工具不可用，重试失败：${error instanceof Error ? error.message : String(error)}`,
											code: "BACKEND_TURN_ERROR"
										}
									});
									return;
								}
							}
							yield* this.finish(turn, {
								kind: "error",
								failure: {
									message: "MiniMax 连续尝试调用内置工具。本插件只允许宿主 MCP 工具，已取消本轮。",
									code: "BACKEND_TURN_ERROR"
								}
							});
							return;
						}
						if (event.stopReason === "end_turn" || event.stopReason === "max_tokens") {
							yield* this.finish(turn, event.stopReason === "max_tokens" ? { kind: "max-tokens" } : { kind: "stop" });
							return;
						}
						if (event.stopReason === "cancelled") {
							yield* this.finish(turn, {
								kind: "aborted",
								failure: {
									message: "MiniMax turn cancelled",
									code: "ABORTED"
								}
							});
							return;
						}
						yield* this.finish(turn, { kind: "stop" });
						return;
					case "prompt-error":
						this.promptInFlight = false;
						this.cancelSent = false;
						yield* this.finish(turn, {
							kind: "error",
							failure: {
								message: event.error.message,
								code: "BACKEND_TURN_ERROR"
							}
						});
						return;
					case "closed":
						this.promptInFlight = false;
						yield* this.finish(turn, {
							kind: "error",
							failure: {
								message: event.error.message,
								code: "BACKEND_TURN_ERROR"
							}
						});
						return;
				}
			}
		} finally {
			if (onAbortListener !== void 0) signal?.removeEventListener("abort", onAbortListener);
			if (abortTimer !== void 0) clearTimeout(abortTimer);
			this.activeTurn = false;
		}
	}
	/** Tear the ACP process down; parked handlers settle with a cancellation. */
	close() {
		if (this.disposed) return;
		this.disposed = true;
		rejectPending(this.pending, /* @__PURE__ */ new Error("MiniMax 会话已关闭。"));
		this.events.close();
		const workspace = this.workspace;
		const owned = this.ownsWorkspace;
		this.workspace = void 0;
		this.ownsWorkspace = false;
		this.dropAcp().finally(() => {
			if (workspace === void 0 || !owned) return;
			try {
				rmSync(workspace, {
					recursive: true,
					force: true
				});
			} catch {}
		});
	}
	async ensureStarted() {
		if (this.acp !== null) return;
		await this.mcpServer.start();
		if (this.workspace === void 0) {
			if (this.requestedCwd !== void 0) {
				this.workspace = this.requestedCwd;
				this.ownsWorkspace = false;
			} else {
				this.workspace = mkdtempSync(join(tmpdir(), "dsh-minimax-session-"));
				this.ownsWorkspace = true;
			}
		}
		this.bridge.setTools(this.toolSchemas);
		const registered = this.mcpServer.register(this.bridge);
		this.mcpToken = registered.token;
		const system = `${this.systemPrompt.trim()}\n\n${HOST_TOOL_POLICY}\n`;
		const acp = new MinimaxAcp({
			region: this.region,
			cwd: this.workspace,
			systemPrompt: system,
			mcpUrl: registered.url,
			mcpToken: registered.token,
			onUpdate: (update) => {
				this.events.push(update);
			},
			onExit: (error) => {
				this.events.push({
					kind: "closed",
					error
				});
			}
		});
		try {
			await acp.start();
			await acp.selectModel(this.model, this.effort);
			this.acp = acp;
		} catch (error) {
			await acp.close();
			this.mcpServer.unregister(registered.token);
			this.mcpToken = void 0;
			throw error;
		}
	}
	async startPrompt(prompt) {
		const acp = this.acp;
		if (acp === null) throw new Error("MiniMax ACP 尚未启动。");
		this.promptInFlight = true;
		this.cancelSent = false;
		this.launchPrompt(acp, prompt, 0);
	}
	/**
	* Start one ACP prompt and publish its outcome.
	*
	* Cancelling a turn makes the next `session/prompt` fail with "Session
	* already has an active Turn" for a short while even though the cancelled
	* prompt has already resolved. That race is routine here: the native-tool
	* correction is sent immediately after such a cancel, so it is retried with
	* a short backoff instead of being reported as a failed turn.
	*/
	async launchPrompt(acp, prompt, attempt) {
		try {
			const response = await acp.prompt(prompt);
			this.events.push({
				kind: "prompt-done",
				stopReason: response.stopReason
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/401 token is required/i.test(message)) {
				minimaxRegionBlocked(this.region, { fresh: true });
				const hint = minimaxRegionBlockedCached(this.region) ? minimaxRegionBlockMessage(this.region) : this.region === "global" ? "MiniMax 国际站拒绝了本机连接（401 token is required）。通常是本机网络 IP 不在国际站服务区域；请检查网络后重试，或切换到国内站。" : "MiniMax 国内站拒绝了本机连接（401 token is required）。请检查网络或重新登录后重试。";
				this.events.push({
					kind: "prompt-error",
					error: new Error(hint)
				});
				return;
			}
			if (/active Turn|already has an active/i.test(message) && attempt < 4 && !this.disposed && this.acp === acp) {
				await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
				if (!this.disposed && this.acp === acp) {
					await this.launchPrompt(acp, prompt, attempt + 1);
					return;
				}
			}
			this.events.push({
				kind: "prompt-error",
				error: error instanceof Error ? error : new Error(message)
			});
		}
	}
	async dropAcp() {
		const acp = this.acp;
		this.acp = null;
		this.promptInFlight = false;
		this.awaitingToolResults = false;
		if (acp !== null) await acp.close();
		if (this.mcpToken !== void 0) {
			this.mcpServer.unregister(this.mcpToken);
			this.mcpToken = void 0;
		}
	}
	async handleToolCall(name, args) {
		if (this.disposed) return {
			content: [{
				type: "text",
				text: "MiniMax 会话已关闭。"
			}],
			isError: true
		};
		const callId = `mm-${this.callNonce}-${++this.toolCounter}`;
		const result = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(callId);
				reject(/* @__PURE__ */ new Error(`宿主工具 ${name} 在 ${Math.round(this.toolResultTimeoutMs / 1e3)} 秒内没有返回结果。`));
			}, this.toolResultTimeoutMs);
			this.pending.set(callId, {
				resolve,
				reject,
				timer
			});
		});
		this.events.push({
			kind: "host-tool",
			callId,
			name,
			args
		});
		try {
			return await result;
		} catch (error) {
			return {
				content: [{
					type: "text",
					text: error instanceof Error ? error.message : String(error)
				}],
				isError: true
			};
		}
	}
	async *finish(turn, reason) {
		if (turn.textBlock !== void 0) yield {
			type: "block-end",
			index: turn.textBlock.index,
			block: {
				type: "text",
				text: turn.textBlock.text
			}
		};
		if (turn.reasoningBlock !== void 0) yield {
			type: "block-end",
			index: turn.reasoningBlock.index,
			block: {
				type: "reasoning",
				text: turn.reasoningBlock.text
			}
		};
		yield {
			type: "usage",
			usage: minimaxTurnUsage({
				...turn.contextUsed === void 0 ? {} : { contextUsed: turn.contextUsed },
				inputChars: turn.inputChars,
				outputChars: turn.outputChars,
				reasoningChars: turn.reasoningChars
			})
		};
		yield {
			type: "finish",
			reason
		};
		if (reason.kind !== "tool-calls" && !this.disposed) this.correctionCount = 0;
	}
};
/** Reject every parked handler with the same reason. */
function rejectPending(pending, error) {
	for (const [callId, entry] of pending) {
		clearTimeout(entry.timer);
		entry.reject(error);
		pending.delete(callId);
	}
}
/** Wait for a promise, or give up after `ms`. */
function withTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
/** Await a queue read, giving up when the harness aborts the turn. */
function raceAbort(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) return Promise.resolve(void 0);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			resolve(void 0);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}
/** Warm session pool, keyed by harness session id. */
var MinimaxSessionManager = class {
	maxSessions;
	mcpServer;
	runtime;
	sessions = /* @__PURE__ */ new Map();
	constructor(maxSessions, mcpServer, runtime = {}) {
		this.maxSessions = maxSessions;
		this.mcpServer = mcpServer;
		this.runtime = runtime;
	}
	forSession(sessionId, region, model) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) {
			if (existing.region !== region) {
				existing.session.close();
				this.sessions.delete(sessionId);
			} else {
				this.sessions.delete(sessionId);
				this.sessions.set(sessionId, existing);
				return existing.session;
			}
		}
		const session = new MinimaxSession(sessionId, model, this.mcpServer, this.runtime);
		this.sessions.set(sessionId, {
			session,
			region
		});
		const cap = readLive(this.maxSessions, 8);
		while (this.sessions.size > cap) {
			const oldest = this.sessions.keys().next();
			if (oldest.done === true) break;
			const victim = this.sessions.get(oldest.value);
			this.sessions.delete(oldest.value);
			victim?.session.close();
		}
		return session;
	}
	dispose(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (entry === void 0) return;
		this.sessions.delete(sessionId);
		entry.session.close();
	}
	closeAll() {
		for (const entry of this.sessions.values()) entry.session.close();
		this.sessions.clear();
	}
};
/** A one-shot turn, used for titles and compaction summaries. */
async function minimaxColdStream(region, prompt, model, options) {
	const chunks = [];
	let text = "";
	const cwd = mkdtempSync(join(tmpdir(), "dsh-minimax-cold-"));
	const acp = new MinimaxAcp({
		region,
		cwd,
		systemPrompt: "You are a concise helper used only for titles and summaries. Do not call any tool.",
		disableTools: true,
		onUpdate: (update) => {
			if (update.kind === "text") text += update.text;
		}
	});
	const signal = options.signal;
	const onAbort = () => {
		acp.cancel();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await acp.start();
		if (model !== void 0) await acp.selectModel(model);
		const response = await acp.prompt(prompt);
		if (signal?.aborted === true || response.stopReason === "cancelled") {
			chunks.push({
				type: "finish",
				reason: {
					kind: "aborted",
					failure: {
						message: "aborted by host",
						code: "ABORTED"
					}
				}
			});
			return chunks;
		}
		if (text.trim().length === 0) {
			chunks.push({
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: "MiniMax side-channel returned no content",
						code: EMPTY_RESPONSE_CODE
					}
				}
			});
			return chunks;
		}
		chunks.push({
			type: "block-start",
			index: 0,
			blockType: "text"
		});
		for (let index = 0; index < text.length; index += 192) chunks.push({
			type: "text-delta",
			index: 0,
			text: text.slice(index, index + 192)
		});
		chunks.push({
			type: "block-end",
			index: 0,
			block: {
				type: "text",
				text
			}
		});
		chunks.push({
			type: "usage",
			usage: minimaxTurnUsage({
				inputChars: prompt.length,
				outputChars: text.length,
				reasoningChars: 0
			})
		});
		chunks.push({
			type: "finish",
			reason: { kind: "stop" }
		});
		return chunks;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await acp.close();
		try {
			rmSync(cwd, {
				recursive: true,
				force: true
			});
		} catch {}
	}
}
//#endregion
//#region src/minimax-adapter.ts
/**
* `MinimaxAdapter`: route the harness LLM seam onto a MiniMax Code account.
*
* The ACP agent owns the conversation; this adapter decides what new text to
* send, which model/effort to select, and how the ACP tool calls map onto the
* harness's tool seam. One provider serves both login regions; the region is a
* live config choice and every ACP process is pinned to it.
*
* @module dsh-agent-sdk-bridge/minimax-adapter
*/
/** The MiniMax Code provider route. */
const MINIMAX_PROVIDER = "minimax-acp";
const NO_MODELS = [];
const NO_ALIASES = {};
/** Map a harness-side id onto an ACP model value. */
function resolveMinimaxModelId(model, aliases = {}) {
	const configured = aliases[model] ?? aliases[model.toLowerCase()];
	if (configured !== void 0 && configured.length > 0) return configured;
	return model.startsWith("minimax-") ? model.slice(8) : model;
}
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.vision ? ["text", "image"] : ["text"]
	};
}
/** The MiniMax Code-backed adapter. */
var MinimaxAdapter = class extends LlmAdapter {
	options;
	sessions;
	catalog;
	auth = new MinimaxAuth();
	mcpServer = new MinimaxMcpServer();
	disabledCache = /* @__PURE__ */ new Map();
	/** Last verified image capability, keyed `${region}:${model}`. */
	knownVision = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		super();
		this.options = options;
		this.sessions = new MinimaxSessionManager(options.maxSessions ?? 8, this.mcpServer, {
			toolResultTimeoutMs: options.toolResultTimeoutMs,
			abortGraceMs: options.abortGraceMs
		});
		this.catalog = new MinimaxCatalog(options.region ?? (() => "cn"), options.modelCacheTtlMs ?? 3e5, options.catalogFetchTimeoutMs ?? 3e4);
	}
	get region() {
		return readLive(this.options.region ?? (() => "cn"), "cn");
	}
	disabledFor(region) {
		const source = this.options.disabledModels?.(region) ?? NO_MODELS;
		const key = source.join("\0");
		const cached = this.disabledCache.get(region);
		if (cached?.key === key) return cached.set;
		const set = new Set(source);
		this.disabledCache.set(region, {
			key,
			set
		});
		return set;
	}
	get aliases() {
		return readLive(this.options.modelAliases, NO_ALIASES);
	}
	get displayName() {
		return readLive(this.options.displayName, "MiniMax Code");
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.displayName
		};
	}
	/** The live catalog, unfiltered (the page must show switched-off models). */
	async describeCatalog(region = this.region) {
		if (!this.isSignedIn(region)) return [];
		if (await minimaxRegionBlocked(region)) return [];
		const models = await this.catalog.models(region);
		for (const model of models) this.knownVision.set(`${region}:${model.id}`, model.vision);
		return models;
	}
	/** Whether the region's endpoints are refusing this machine's network. */
	regionBlocked(region = this.region) {
		return minimaxRegionBlockedCached(region);
	}
	/** Whether the selected (or given) region has a stored login. */
	isSignedIn(region = this.region) {
		return this.auth.status(region).signedIn || minimaxSignedIn(region);
	}
	/** Why the last catalog read failed, for the page's guidance. */
	catalogError(region = this.region) {
		if (resolveMinimaxCli() === void 0) return "未安装 MiniMax Code CLI（mcode）。请先安装后再登录。";
		if (minimaxRegionBlockedCached(region)) return minimaxRegionBlockMessage(region);
		if (!this.isSignedIn(region)) return "请先登录 MiniMax Code，登录后才会读取并显示模型目录。";
		return this.catalog.error(region);
	}
	/**
	* Drop the cached catalog and the region verdict behind it.
	*
	* The page calls this with `fresh=1` on a region switch, which is exactly
	* when the network may have changed; keeping a 30-second "blocked" verdict
	* would hide the catalog the switch was meant to reveal.
	*/
	invalidateCatalog(region) {
		this.catalog.invalidate(region);
		invalidateMinimaxRegionAccess(region);
	}
	/** Login status, installer state and (when signed in) the account's quota. */
	async usageInfo(fresh = false, region) {
		const target = region ?? this.region;
		const installed = resolveMinimaxCli() !== void 0;
		const status = this.auth.status(target);
		if (!(status.signedIn || minimaxSignedIn(target))) return {
			at: Date.now(),
			region: target,
			signedIn: false,
			installed,
			...installed ? {} : { error: "未安装 MiniMax Code CLI（mcode）。" },
			...status.error === void 0 ? {} : { error: status.error }
		};
		const snapshot = await minimaxUsage(target, { fresh });
		return {
			...snapshot,
			signedIn: true,
			installed,
			...snapshot.error !== void 0 || status.error === void 0 ? {} : { error: status.error }
		};
	}
	/** Drop cached quota readings and the region verdict (login, logout, CLI). */
	invalidateUsage(region) {
		invalidateMinimaxUsage(region);
		invalidateMinimaxRegionAccess(region);
	}
	/** Login progress for one region; the page polls this. */
	authStatus(region) {
		return this.auth.status(region);
	}
	startLogin(region) {
		return this.auth.start(region, (ok) => {
			if (!ok) return;
			this.sessions.closeAll();
			this.invalidateCatalog(region);
			this.invalidateUsage(region);
			invalidateMinimaxRegionAccess(region);
		});
	}
	async logout(region) {
		const result = await this.auth.logout(region);
		this.sessions.closeAll();
		this.invalidateCatalog(region);
		this.invalidateUsage(region);
		invalidateMinimaxRegionAccess(region);
		return result;
	}
	isModelDisabled(id, region = this.region) {
		return this.disabledFor(region).has(id);
	}
	contextWindowFor(id, region = this.region) {
		return this.options.modelContextWindows?.(region)[id];
	}
	async listModels(provider) {
		const region = this.region;
		if (!this.isSignedIn(region)) return [];
		if (await minimaxRegionBlocked(region)) return [];
		const models = await this.catalog.models(region);
		const disabled = this.disabledFor(region);
		return models.filter((model) => !disabled.has(model.id)).map((model) => modelInfo(provider, model));
	}
	async resolveModel(provider, model) {
		const region = this.region;
		const target = resolveMinimaxModelId(model, this.aliases);
		const key = `${region}:${target}`;
		const live = (await cachedModels(this.catalog.snapshot(region), () => this.catalog.models(region))).find((entry) => entry.id === target);
		if (live !== void 0) {
			this.knownVision.set(key, live.vision);
			const reasoning = reasoningInfo(live.reasoningEfforts, readLiveOptional(this.options.defaultReasoningEffort), live.reasoning);
			return {
				provider,
				id: model,
				name: live.name,
				...live.description === void 0 ? {} : { description: live.description },
				inputModalities: live.vision ? ["text", "image"] : ["text"],
				context: { contextWindow: this.contextWindowFor(target, region) ?? live.defaultContextWindow },
				defaultMaxTokens: readLive(this.options.defaultMaxTokens, MINIMAX_DEFAULT_MAX_TOKENS),
				...reasoning === void 0 ? {} : { reasoning }
			};
		}
		const reasoning = reasoningInfo(void 0, readLiveOptional(this.options.defaultReasoningEffort), true);
		return {
			provider,
			id: model,
			name: model,
			inputModalities: this.knownVision.get(key) === true ? ["text", "image"] : ["text"],
			context: { contextWindow: this.contextWindowFor(target, region) ?? 512e3 },
			defaultMaxTokens: readLive(this.options.defaultMaxTokens, MINIMAX_DEFAULT_MAX_TOKENS),
			...reasoning === void 0 ? {} : { reasoning }
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.dispatch(options)
		};
	}
	async *stream(options) {
		yield* this.dispatch(options);
	}
	async *dispatch(options) {
		const region = this.region;
		if (!this.isSignedIn(region)) throw new Error(`${region === "cn" ? "MiniMax 国内站" : "MiniMax 国际站"}尚未登录，请先在设置 → MiniMax Code 中登录。`);
		if (await minimaxRegionBlocked(region)) throw new Error(minimaxRegionBlockMessage(region));
		const model = resolveMinimaxModelId(options.model, this.aliases);
		if (options.sessionId === void 0 || options.purpose !== void 0) {
			const prompt = feedToText(renderInitialFeed(options.system, options.messages, this.options.imagePath), this.options.imagePath) + "\n（这是一次性旁路请求，直接输出下一条助手回复。）";
			for (const chunk of await minimaxColdStream(region, prompt, model, options)) yield chunk;
			return;
		}
		const sessionId = String(options.sessionId);
		const effort = options.reasoningEffort ?? readLiveOptional(this.options.defaultReasoningEffort);
		let session = this.sessions.forSession(sessionId, region, model);
		if (session.fedMessages === void 0) {
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		const tail = options.messages.slice(session.fedMessages.length);
		session.deliverToolResults(tail);
		const plan = planContinuation(session.fedMessages, options.messages);
		if (plan.rebuild) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, region, model);
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		if (plan.feed !== null && session.busy) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, region, model);
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		if (session.configure(region, model, {
			effort,
			system: options.system,
			cwd: this.cwdOf(options)
		}) || plan.feed === null && !session.busy) {
			this.sessions.dispose(sessionId);
			session = this.sessions.forSession(sessionId, region, model);
			yield* this.firstTurn(session, options, region, model, effort);
			return;
		}
		session.ensureTools(options.tools ?? []);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const vision = await this.modelVision(model, region);
		const feed = plan.feed === null ? null : await this.buildFeed(plan.feed, vision, options.signal);
		yield* session.stream(options, feed);
	}
	async *firstTurn(session, options, region, model, effort) {
		session.configure(region, model, {
			effort,
			system: options.system,
			cwd: this.cwdOf(options)
		});
		session.ensureTools(options.tools ?? []);
		session.fedMessages = options.messages;
		session.fedSystem = options.system;
		const vision = await this.modelVision(model, region);
		const feed = await this.buildFeed(renderInitialFeed(void 0, options.messages, this.options.imagePath), vision, options.signal);
		yield* session.stream(options, feed);
	}
	/** Whether the resolved model accepts images (drives whether pixels are sent). */
	async modelVision(model, region) {
		const target = resolveMinimaxModelId(model, this.aliases);
		const key = `${region}:${target}`;
		const live = (await this.catalog.models(region).catch(() => [])).find((entry) => entry.id === target);
		if (live !== void 0) {
			this.knownVision.set(key, live.vision);
			return live.vision;
		}
		return this.knownVision.get(key) === true;
	}
	/**
	* Turn a feed into what one ACP prompt carries.
	*
	* A text-only feed stays a plain string (the historical shape). A feed with
	* readable images becomes ACP content blocks, because an image block is the
	* only thing the agent receives as pixels. An image the host could not read
	* keeps its handle text, so it degrades one part instead of failing the turn.
	*/
	async buildFeed(feed, vision, signal) {
		if (typeof feed === "string") return feed;
		if (!vision) return feedToText(feed, this.options.imagePath);
		const images = /* @__PURE__ */ new Map();
		const readImage = this.options.readImage;
		if (readImage !== void 0) for (const ref of feedImageRefs(feed)) {
			const key = String(ref.attachmentId);
			if (images.has(key)) continue;
			try {
				const image = await readImage(ref, signal);
				if (image !== void 0) images.set(key, {
					data: Buffer.from(image.bytes).toString("base64"),
					mediaType: image.mediaType
				});
			} catch {}
		}
		const parts = resolvedFeedParts(feed, images);
		if (!parts.some((part) => part.type !== "text")) return parts.map((part) => part.type === "text" ? part.text : "").join("\n\n");
		const content = [];
		for (const part of parts) {
			if (part.type === "text") {
				content.push({
					type: "text",
					text: part.text
				});
				continue;
			}
			const path = this.options.imagePath?.(part.attachment);
			content.push({
				type: "text",
				text: part.type === "image-unreadable" && path === void 0 ? `[图片附件 ${String(part.attachment.attachmentId)} 本次未能读取，请基于文字内容继续]` : imageRefText(part.attachment, path)
			});
			if (part.type === "image-unreadable") continue;
			content.push({
				type: "image",
				data: part.data,
				mimeType: part.mediaType
			});
		}
		return content;
	}
	cwdOf(options) {
		return options.cwd;
	}
	close() {
		this.sessions.closeAll();
		this.mcpServer.close();
		this.auth.stop();
	}
};
//#endregion
//#region src/setup.ts
/**
* Runs the bundled Windows helper that installs and signs into a Qoder CLI
* (one helper per edition: `qoderclicn` for CN, `qodercli` for international).
*
* The settings page cannot do this by itself: a browser has no way to start a
* local process, and the plugin's own process is the one that already talks to
* the CLI. So the page asks this module, and this module spawns
* {@link SCRIPT_NAME} — the same script a user can double-click — with one of
* two fixed flags, and buffers its output so the page can show progress while
* the browser sign-in is still open.
*
* Nothing user-supplied reaches the command line: the mode is an allow-list of
* two keys mapped to two literal flags, and the script path comes from this
* package's own layout. The helper is idempotent, so a second press re-checks
* rather than reinstalling.
*
* @module dsh-agent-sdk-bridge/setup
*/
/** File name of the CN helper, shipped under this package's `scripts/` directory. */
const SCRIPT_NAME = "setup-qoderclicn.bat";
/** The helper script for one edition. */
function scriptNameOf(brand) {
	return brandProfile(brand).setupScript ?? "setup-qoderclicn.bat";
}
/** The one command-line flag each mode maps to. Never a user-supplied string. */
const FLAGS = {
	configure: "--gui",
	login: "--login",
	logout: "--logout",
	uninstall: "--uninstall"
};
/** Whether a value is one of the modes the page may request. */
function isSetupMode(value) {
	return value === "configure" || value === "login" || value === "logout" || value === "uninstall";
}
/** Cap on kept output, so a chatty `npm install` cannot grow without bound. */
const MAX_LINES = 400;
/** The latest run per edition: the two installers may run independently. */
const current = /* @__PURE__ */ new Map();
/**
* Locate one edition's helper inside this package.
*
* The host half is bundled to `lib/index.js`, and tests import `src/*.ts`, so
* both layouts resolve to the same `scripts/` directory one level up.
*
* @param brand - which edition's script to find.
*/
function setupScriptPath(brand = "cn") {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const script = scriptNameOf(brand);
	for (const candidate of [path.resolve(here, "..", "scripts", script), path.resolve(here, "scripts", script)]) if (existsSync(candidate)) return candidate;
}
/** Append decoded text to a run, splitting it into displayable lines. */
function absorb(run, chunk, done) {
	run.pending += run.decoder.decode(chunk, { stream: !done });
	const parts = run.pending.split(/\r\n|\r|\n/);
	run.pending = done ? "" : parts.pop() ?? "";
	for (const part of parts) {
		if (part.trim() === "") continue;
		run.lines.push(part);
	}
	if (done && run.pending.trim() !== "") run.lines.push(run.pending.trim());
	while (run.lines.length > MAX_LINES) {
		run.lines.shift();
		run.truncated = true;
	}
}
/**
* Start one edition's helper. Only one run per edition at a time; a finished
* one stays readable.
*
* @param brand - which edition to configure.
* @param mode - the fixed flag the page may ask for.
* @param onFinish - called once with the exit code.
*/
function startSetup(brand, mode, onFinish) {
	const previous = current.get(brand);
	if (previous !== void 0 && previous.finishedAt === void 0) return {
		started: false,
		reason: "busy",
		error: "已经有一次配置在跑了，请等它结束。"
	};
	if (process.platform !== "win32") {
		const command = brandProfile(brand).cliCommands[0];
		return {
			started: false,
			reason: "unsupported",
			error: `一键${mode === "uninstall" ? "卸载" : mode === "logout" ? "退出登录" : mode === "login" ? "重新登录" : "配置"}只支持 Windows，请在 CLI 所在机器上手动处理 ${command}。`
		};
	}
	const script = setupScriptPath(brand);
	if (script === void 0) return {
		started: false,
		reason: "missing-script",
		error: `插件包里没有 ${scriptNameOf(brand)}，缺少 scripts/ 目录。`
	};
	const run = {
		child: void 0,
		brand,
		mode,
		startedAt: Date.now(),
		lines: [],
		pending: "",
		decoder: new TextDecoder("utf-8"),
		truncated: false
	};
	const child = spawn(process.env.ComSpec ?? "cmd.exe", [
		"/d",
		"/c",
		script,
		FLAGS[mode]
	], {
		cwd: homedir(),
		windowsHide: true,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	run.child = child;
	current.set(brand, run);
	const finish = (code) => {
		if (run.finishedAt !== void 0) return;
		run.finishedAt = Date.now();
		run.code = code;
		try {
			onFinish?.(code);
		} catch (error) {
			run.lines.push(`收尾回调失败：${error instanceof Error ? error.message : String(error)}`);
		}
	};
	child.stdout?.on("data", (chunk) => absorb(run, chunk, false));
	child.stderr?.on("data", (chunk) => absorb(run, chunk, false));
	child.on("error", (error) => {
		run.lines.push(`无法启动 ${scriptNameOf(brand)}：${error instanceof Error ? error.message : String(error)}`);
		finish(null);
	});
	child.on("close", (code) => {
		absorb(run, /* @__PURE__ */ new Uint8Array(), true);
		finish(code);
	});
	return { started: true };
}
/**
* The latest run of one edition, with any not-yet-newlined tail included for
* live display.
*
* @param brand - which edition's run to report.
*/
function readSetupStatus(brand = "cn") {
	const installed = resolveQoderCli(brand) !== void 0;
	const cliVersion = installed ? installedCliVersion(brand) : void 0;
	const required = requiredCliVersion(brand);
	const build = {
		installed,
		...cliVersion === void 0 ? {} : { cliVersion },
		...required === void 0 ? {} : { requiredCliVersion: required },
		...cliVersion === void 0 || required === void 0 ? {} : { versionMismatch: cliVersion !== required }
	};
	const run = current.get(brand);
	if (run === void 0) return {
		running: false,
		lines: [],
		truncated: false,
		...build
	};
	const lines = run.pending.trim() === "" ? run.lines : [...run.lines, run.pending.trim()];
	return {
		running: run.finishedAt === void 0,
		mode: run.mode,
		startedAt: run.startedAt,
		...run.finishedAt === void 0 ? {} : {
			finishedAt: run.finishedAt,
			code: run.code ?? null
		},
		lines,
		truncated: run.truncated,
		...build,
		...run.cancelled === true ? { cancelled: true } : {}
	};
}
/**
* Abandon the running helper for one edition.
*
* `qodercli login` waits for the browser to finish the callback, so closing
* that tab left the page polling a process that would never return. Killing
* the run turns it into a finished one (`code` null) so the page can offer the
* buttons again instead of showing a spinner forever.
*
* @param brand - which edition's run to stop.
* @returns whether a run was actually in flight.
*/
function cancelSetup(brand) {
	const run = current.get(brand);
	if (run === void 0 || run.finishedAt !== void 0) return false;
	run.lines.push("已取消：这次配置被手动终止，可以重新操作。");
	run.cancelled = true;
	try {
		run.child.kill();
	} catch {}
	run.finishedAt = Date.now();
	run.code = null;
	return true;
}
/**
* Abandon the running helper, if any.
*
* Called when the plugin is disposed. Killing `cmd.exe` does not reap the CLI it
* already launched, but the helper's own wait is bounded, so nothing hangs on
* the far end.
*/
function stopSetup() {
	for (const run of current.values()) if (run.finishedAt === void 0) run.child.kill();
}
//#endregion
//#region src/api.ts
/** Route prefix this plugin owns; the client resolves it relative to the page. */
const API_PREFIX = "/api/llm-qoder-cn";
/** Answer one request with JSON. */
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** Build model rows for a Qoder adapter. */
async function buildRows(adapter) {
	return (await adapter.describeCatalog()).map((entry) => {
		const override = adapter.contextWindowFor(entry.value);
		const upstream = entry.defaultContextWindow ?? (entry.availableContextWindows !== void 0 && entry.availableContextWindows.length > 0 ? Math.max(...entry.availableContextWindows) : entry.maxInputTokens) ?? 2e5;
		const choices = new Set(entry.availableContextWindows ?? []);
		choices.add(upstream);
		if (override !== void 0) choices.add(override);
		const priceFactor = priceFactorOf(entry);
		return {
			id: entry.value,
			name: entry.displayName.length > 0 ? entry.displayName : entry.value,
			...entry.description.length > 0 ? { description: entry.description } : {},
			enabled: !adapter.isModelDisabled(entry.value),
			vision: entry.isVl === true,
			contextWindow: override ?? upstream,
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: upstream,
			...override === void 0 ? {} : { override },
			...priceFactor === void 0 ? {} : { priceFactor },
			reasoning: entry.isReasoning !== false,
			contextWindowSelectable: (entry.availableContextWindows?.length ?? 0) > 1
		};
	});
}
/** Build model rows for the CodeBuddy adapter, for one login region. */
async function buildCodeBuddyRows(adapter, region) {
	return (await adapter.describeCatalog(region)).map((entry) => {
		const override = adapter.contextWindowFor(entry.id, region);
		const choices = new Set(entry.contextWindows);
		if (override !== void 0) choices.add(override);
		return {
			id: entry.id,
			name: entry.name,
			...entry.description === void 0 ? {} : { description: entry.description },
			enabled: !adapter.isModelDisabled(entry.id, region),
			vision: entry.vision,
			contextWindow: override ?? entry.defaultContextWindow,
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: entry.defaultContextWindow,
			...override === void 0 ? {} : { override },
			...entry.priceFactor === void 0 ? {} : { priceFactor: entry.priceFactor },
			reasoning: (entry.reasoningEfforts?.length ?? 0) > 0,
			contextWindowSelectable: entry.contextWindows.length > 0
		};
	});
}
/** Build model rows for the MiniMax adapter, for one login region. */
async function buildMinimaxRows(adapter, region) {
	return (await adapter.describeCatalog(region)).map((entry) => {
		const override = adapter.contextWindowFor(entry.id, region);
		const choices = new Set(entry.contextWindows);
		choices.add(entry.defaultContextWindow);
		if (override !== void 0) choices.add(override);
		return {
			id: entry.id,
			name: entry.name,
			...entry.description === void 0 ? {} : { description: entry.description },
			enabled: !adapter.isModelDisabled(entry.id, region),
			vision: entry.vision,
			contextWindow: override ?? entry.defaultContextWindow,
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: entry.defaultContextWindow,
			...override === void 0 ? {} : { override },
			reasoning: entry.reasoning
		};
	});
}
/** Largest request body this route accepts. */
const MAX_BODY_BYTES = 2048;
/** Read and parse a small JSON request body. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const part of req) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") throw new Error("缺少请求体");
	return JSON.parse(text);
}
/** The brand a query-string or body selected, or undefined when it named none. */
function brandFrom(value) {
	if (value === null || value === void 0 || value === "") return "cn";
	return isBrandId(value) ? value : void 0;
}
/** A CodeBuddy region from a query or body, defaulting to the international one. */
function regionFrom(value) {
	if (value === null || value === void 0 || value === "") return "global";
	return isCodeBuddyRegion(value) ? value : void 0;
}
/** Handle one request under {@link API_PREFIX}. */
async function handleApi(req, res, adapters) {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname.slice(17) || "/";
		const method = req.method ?? "GET";
		const queryBrand = brandFrom(url.searchParams.get("brand"));
		if (queryBrand === void 0) {
			send(res, 400, { error: "brand 只接受 cn、global、codebuddy 或 minimax" });
			return;
		}
		const adapter = adapters[queryBrand];
		const codebuddy = queryBrand === "codebuddy" ? adapter : void 0;
		const minimax = queryBrand === "minimax" ? adapter : void 0;
		const regional = codebuddy !== void 0 || minimax !== void 0;
		if (path === "/models" && method === "GET") {
			const requestedRegion = url.searchParams.get("region");
			const region = requestedRegion === null || requestedRegion === "" ? void 0 : regionFrom(requestedRegion);
			if (regional && region === void 0 && requestedRegion !== null && requestedRegion !== "") {
				send(res, 400, { error: "region 只接受 global 或 cn" });
				return;
			}
			if (url.searchParams.get("fresh") === "1") {
				if (codebuddy !== void 0) codebuddy.invalidateCatalog(region);
				else if (minimax !== void 0) minimax.invalidateCatalog(region);
				else adapter.invalidateCatalog();
			}
			const signedIn = codebuddy?.isSignedIn(region) ?? minimax?.isSignedIn(region);
			const rows = codebuddy !== void 0 ? signedIn === false ? [] : await buildCodeBuddyRows(codebuddy, region) : minimax !== void 0 ? signedIn === false ? [] : await buildMinimaxRows(minimax, region) : await buildRows(adapter);
			const notice = rows.length === 0 ? codebuddy !== void 0 ? codebuddy.catalogError(region) : minimax !== void 0 ? minimax.catalogError(region) : adapter.catalogError() : void 0;
			send(res, 200, {
				brand: queryBrand,
				models: rows,
				...region === void 0 ? {} : { region },
				...signedIn === void 0 ? {} : { signedIn },
				...minimax === void 0 ? {} : { regionBlocked: minimax.regionBlocked(region) },
				...notice === void 0 ? {} : { notice }
			});
			return;
		}
		if (path === "/usage" && method === "GET") {
			const requested = url.searchParams.get("region");
			const region = requested === null || requested === "" ? void 0 : regionFrom(requested);
			if (regional && region === void 0 && requested !== null && requested !== "") {
				send(res, 400, { error: "region 只接受 global 或 cn" });
				return;
			}
			const fresh = url.searchParams.get("fresh") === "1";
			send(res, 200, {
				brand: queryBrand,
				...codebuddy !== void 0 ? await codebuddy.usageInfo(fresh, region) : minimax !== void 0 ? await minimax.usageInfo(fresh, region) : await adapter.usageInfo(fresh),
				...codebuddy === void 0 && minimax === void 0 ? {} : { signedIn: (codebuddy ?? minimax).isSignedIn(region) }
			});
			return;
		}
		if (path === "/auth") {
			if (method === "GET") {
				if (codebuddy === void 0 && minimax === void 0) {
					send(res, 404, { error: "该 provider 没有浏览器登录流程" });
					return;
				}
				const region = regionFrom(url.searchParams.get("region"));
				if (region === void 0) {
					send(res, 400, { error: "region 只接受 global 或 cn" });
					return;
				}
				send(res, 200, codebuddy !== void 0 ? {
					brand: "codebuddy",
					...codebuddy.authStatus(region)
				} : {
					brand: "minimax",
					...minimax.authStatus(region)
				});
				return;
			}
			if (method === "POST") {
				let body;
				try {
					body = await readJson(req) ?? {};
				} catch (error) {
					send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` });
					return;
				}
				const postBrand = brandFrom(body.brand);
				if (postBrand !== "codebuddy" && postBrand !== "minimax") {
					send(res, 400, { error: "该 provider 没有浏览器登录流程" });
					return;
				}
				const region = regionFrom(body.region);
				if (region === void 0) {
					send(res, 400, { error: "region 只接受 global 或 cn" });
					return;
				}
				if (body.action !== "login" && body.action !== "logout") {
					send(res, 400, { error: "action 只接受 login 或 logout" });
					return;
				}
				if (postBrand === "codebuddy") {
					const cb = adapters.codebuddy;
					if (body.action === "logout") {
						const result = await cb.logout(region);
						if (!result.ok) {
							send(res, 500, { error: result.error });
							return;
						}
						send(res, 200, {
							brand: "codebuddy",
							...cb.authStatus(region)
						});
						return;
					}
					const started = cb.startLogin(region);
					if (started.started === false) {
						send(res, 409, { error: started.error });
						return;
					}
					send(res, 200, {
						brand: "codebuddy",
						...cb.authStatus(region)
					});
					return;
				}
				const mm = adapters.minimax;
				if (body.action === "logout") {
					send(res, 200, {
						brand: "minimax",
						...await mm.logout(region)
					});
					return;
				}
				const started = mm.startLogin(region);
				if (started.started === false) {
					send(res, 409, { error: started.error });
					return;
				}
				send(res, 200, {
					brand: "minimax",
					...mm.authStatus(region)
				});
				return;
			}
		}
		if (path === "/setup") {
			if (method === "GET") {
				if (codebuddy !== void 0) {
					send(res, 400, { error: "CodeBuddy 不需要安装 CLI，请在页面中登录" });
					return;
				}
				if (minimax !== void 0) {
					send(res, 200, readMinimaxSetupStatus());
					return;
				}
				send(res, 200, readSetupStatus(queryBrand));
				return;
			}
			if (method === "POST") {
				let parsed;
				try {
					parsed = await readJson(req) ?? {};
				} catch (error) {
					send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` });
					return;
				}
				const postBrand = brandFrom(parsed.brand);
				if (postBrand === void 0) {
					send(res, 400, { error: "brand 只接受 cn、global、codebuddy 或 minimax" });
					return;
				}
				if (postBrand === "codebuddy") {
					send(res, 400, { error: "CodeBuddy 不需要安装 CLI，请在页面中登录" });
					return;
				}
				if (postBrand === "minimax") {
					if (!isMinimaxSetupMode(parsed.mode)) {
						send(res, 400, { error: "mode 只接受 install 或 uninstall" });
						return;
					}
					const mm = adapters.minimax;
					const result = startMinimaxSetup(parsed.mode, (code) => {
						if (code !== 0) return;
						mm.invalidateCatalog();
						mm.invalidateUsage();
					});
					if (!result.started) {
						send(res, result.reason === "busy" ? 409 : 501, { error: result.error });
						return;
					}
					send(res, 200, readMinimaxSetupStatus());
					return;
				}
				if (parsed.mode === "cancel") {
					cancelSetup(postBrand);
					send(res, 200, readSetupStatus(postBrand));
					return;
				}
				if (!isSetupMode(parsed.mode)) {
					send(res, 400, { error: "mode 只接受 configure、login、logout、uninstall 或 cancel" });
					return;
				}
				const qoder = adapters[postBrand];
				const mode = parsed.mode;
				const result = startSetup(postBrand, mode, (code) => {
					if (code !== 0) return;
					qoder.invalidateCatalog();
					qoder.invalidateUsage();
					if (mode === "logout") qoder.closeSessions();
				});
				if (!result.started) {
					send(res, result.reason === "busy" ? 409 : result.reason === "unsupported" ? 501 : 500, { error: result.error });
					return;
				}
				send(res, 200, readSetupStatus(postBrand));
				return;
			}
			send(res, 405, { error: "不支持的写入路径" });
			return;
		}
		send(res, method === "GET" ? 404 : 405, { error: method === "GET" ? "not found" : "不支持的写入路径" });
	} catch (error) {
		send(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion
//#region src/config.ts
/**
* The plugin's configuration surface.
*
* DSH's settings service reads a plugin's exported `Config` schema and, when no
* custom page is registered for that entry, auto-generates a settings page from
* it (`autoGenerate` defaults to true in `dsh-settings`). That makes this schema
* the single source of truth for both runtime behaviour and the settings UI —
* every field documented here appears as a labelled control, and its
* `description` becomes the help text under it.
*
* Field order matters: the generated form renders in declaration order, so the
* groups below are arranged the way a user reads them (identity → capacity →
* context → timeouts → models → aliases).
*
* @module dsh-agent-sdk-bridge/config
*/
/**
* The configuration schema. This is what DSH turns into the settings page, so
* the defaults and bounds here are user-visible documentation.
*
* ## Why every field is `.volatile()`
*
* DSH's settings service builds its form from `volatileForm(schema)`, which
* keeps a field ONLY when the node (or an ancestor) carries `meta.volatile`;
* an object whose fields are all non-volatile collapses to `undefined` and the
* whole namespace is dropped from `describe()` before any client sees it. A
* plugin with a plain schema therefore registers successfully, streams models
* correctly, and still shows no settings page anywhere — the namespace never
* reaches the wire.
*
* ## What `.volatile()` costs: read every field at use
*
* A volatile-only edit does not restart the plugin. The loader writes the new
* value into the *same* `Volatile` cell the running plugin already holds and
* skips the rest of the update lifecycle, so `apply()` is never called again
* (`Entry.update` → `_commitVolatile` in `cordis-plugin-loader`). Capturing a
* field in `apply()` therefore freezes it for the lifetime of the process, and
* the plugin answers with mount-time values while the settings page and the
* profile patch on disk show the new ones.
*
* That is why the whole plugin consumes its config through {@link liveConfig},
* which returns a thunk per field: the value is unwrapped from its volatile
* reference at every read, so an in-place edit is visible immediately. See
* `src/live.ts` for the full mechanism.
*/
const Config$1 = z$1.object({
	cnEnabled: z$1.boolean().default(true).description("启用 Qoder CN。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。").volatile(),
	intlEnabled: z$1.boolean().default(true).description("启用 Qoder 国际版。关闭后该设置页、模型列表与 provider 路由都会移除；已保存的模型选择会保留。").volatile(),
	codebuddyEnabled: z$1.boolean().default(true).description("启用 CodeBuddy。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。").volatile(),
	disabledModels: z$1.array(z$1.string()).default([]).description("已关闭的模型 ID 列表（以 Qoder 模型 ID 为准）。关闭的模型不会出现在模型选择器里。").volatile(),
	modelContextWindows: z$1.dict(z$1.number()).default({}).description("按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。").volatile(),
	intlDisabledModels: z$1.array(z$1.string()).default([]).description("国际版已关闭的模型 ID 列表。与 CN 列表分开，因为两边的模型目录不同。").volatile(),
	intlModelContextWindows: z$1.dict(z$1.number()).default({}).description("国际版按模型指定的上下文窗口（token 数）。").volatile(),
	intlModelAliases: z$1.dict(z$1.string()).default({}).description("国际版额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。").volatile(),
	intlDisplayName: z$1.string().default("Qoder 国际版").description("模型选择器里国际版分组的名称。").volatile(),
	codebuddyRegion: z$1.string().default("global").description("CodeBuddy 登录区域：global（国际版，codebuddy.ai）或 cn（国内版，copilot.tencent.com）。切换后使用对应区域的登录态。").volatile(),
	codebuddyDisplayName: z$1.string().default("CodeBuddy").description("模型选择器里 CodeBuddy 分组的名称。").volatile(),
	codebuddyGlobalDisabledModels: z$1.array(z$1.string()).default([]).description("CodeBuddy 国际版（codebuddy.ai）已关闭的模型 ID 列表。").volatile(),
	codebuddyCnDisabledModels: z$1.array(z$1.string()).default([]).description("CodeBuddy 国内版（copilot.tencent.com）已关闭的模型 ID 列表。").volatile(),
	codebuddyGlobalModelContextWindows: z$1.dict(z$1.number()).default({}).description("CodeBuddy 国际版按模型指定的上下文窗口（token 数）。").volatile(),
	codebuddyCnModelContextWindows: z$1.dict(z$1.number()).default({}).description("CodeBuddy 国内版按模型指定的上下文窗口（token 数）。").volatile(),
	codebuddyModelAliases: z$1.dict(z$1.string()).default({}).description("CodeBuddy 额外的模型别名映射：DSH 侧名称 → CodeBuddy 模型 ID。").volatile(),
	minimaxEnabled: z$1.boolean().default(true).description("启用 MiniMax Code（ACP）。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。").volatile(),
	minimaxRegion: z$1.string().default("cn").description("MiniMax Code 登录区域：cn（国内站 account.minimax.cn）或 global（国际站 account.minimax.io）。").volatile(),
	minimaxDisplayName: z$1.string().default("MiniMax Code").description("模型选择器里 MiniMax Code 分组的名称。").volatile(),
	minimaxGlobalDisabledModels: z$1.array(z$1.string()).default([]).description("MiniMax Code 国际站已关闭的模型 ID 列表。").volatile(),
	minimaxCnDisabledModels: z$1.array(z$1.string()).default([]).description("MiniMax Code 国内站已关闭的模型 ID 列表。").volatile(),
	minimaxGlobalModelContextWindows: z$1.dict(z$1.number()).default({}).description("MiniMax Code 国际站按模型指定的上下文窗口（token 数）。").volatile(),
	minimaxCnModelContextWindows: z$1.dict(z$1.number()).default({}).description("MiniMax Code 国内站按模型指定的上下文窗口（token 数）。").volatile(),
	minimaxModelAliases: z$1.dict(z$1.string()).default({}).description("MiniMax Code 额外的模型别名映射：DSH 侧名称 → ACP 模型值。").volatile(),
	displayName: z$1.string().default("Qoder CN").description("模型选择器里主分组的名称。同时使用多个 Qoder 账号时可区分。").volatile(),
	maxSessions: z$1.number().step(1).min(1).max(64).default(8).description("同时保持的内层会话数上限，超出后按最久未使用关闭。每个会话是一个子进程。").volatile(),
	modelCacheTtlSeconds: z$1.number().step(1).min(10).max(86400).default(300).description("模型列表缓存时长（秒）。调小可更快看到账号侧变化。").volatile(),
	modelAliases: z$1.dict(z$1.string()).default({}).description("额外的模型别名映射：DSH 侧名称 → Qoder 模型 ID。内置 deepseek-v4-* 别名仍然生效。").volatile(),
	defaultReasoningEffort: z$1.string().default("").description("默认选用的思考档位；留空则用该模型支持的最强档位。").volatile(),
	defaultMaxTokens: z$1.number().step(1).min(1).default(32e3).description("模型未声明输出上限时使用的输出上限。").volatile(),
	toolResultTimeoutSeconds: z$1.number().step(1).min(5).max(3600).default(120).description("仅用于未配对 handler 的兜底时限（秒）：正常工具调用会等宿主下一次请求携带结果，不按此超时。").volatile(),
	catalogFetchTimeoutSeconds: z$1.number().step(1).min(1).max(300).default(20).description("拉取模型列表的时限（秒），超时后回退到内置列表。").volatile(),
	abortGraceSeconds: z$1.number().step(1).min(1).max(120).default(5).description("内层进程确认中断的宽限时间（秒）。").volatile(),
	coldMaxTurns: z$1.number().step(1).min(1).max(32).default(4).description("旁路请求（生成标题、压缩摘要）允许的最大内层轮次。").volatile()
});
/**
* Wrap a parsed config as {@link LiveConfig}.
*
* Every normalizer {@link resolveConfig} applies is applied here too — the live
* wrapper is the same interpretation of the same raw fields, just deferred —
* and `resolveConfig` is implemented on top of it, so the two can never
* disagree about what a given input means.
*
* @param config - the parsed plugin config, possibly partial or absent.
* @returns one thunk per resolved field, each reading the live cell.
*/
function liveConfig(config) {
	const source = config ?? {};
	/**
	* One field's current value.
	*
	* The volatile unwrap happens on every call rather than once, which is the
	* entire point: the reference object outlives an edit, only its contents
	* change.
	*/
	const field = (key) => {
		const value = source[key];
		return isVolatile(value) ? value.get() : value;
	};
	return {
		cnEnabled: () => bool(field("cnEnabled"), true),
		intlEnabled: () => bool(field("intlEnabled"), true),
		codebuddyEnabled: () => bool(field("codebuddyEnabled"), true),
		codebuddyRegion: () => field("codebuddyRegion") === "cn" ? "cn" : "global",
		displayName: () => nonEmpty(field("displayName"), "Qoder CN"),
		maxSessions: () => positive(field("maxSessions"), 8),
		modelCacheTtlMs: () => positive(field("modelCacheTtlSeconds"), 300) * 1e3,
		defaultMaxTokens: () => positive(field("defaultMaxTokens"), 32e3),
		toolResultTimeoutMs: () => positive(field("toolResultTimeoutSeconds"), 120) * 1e3,
		catalogFetchTimeoutMs: () => positive(field("catalogFetchTimeoutSeconds"), 20) * 1e3,
		abortGraceMs: () => positive(field("abortGraceSeconds"), 5) * 1e3,
		coldMaxTurns: () => positive(field("coldMaxTurns"), 4),
		disabledModels: () => stringList(field("disabledModels")),
		modelContextWindows: () => numberMap(field("modelContextWindows")),
		modelAliases: () => stringMap(field("modelAliases")),
		defaultReasoningEffort: () => {
			const raw = field("defaultReasoningEffort");
			const effort = typeof raw === "string" ? raw.trim() : "";
			return effort.length > 0 ? effort : void 0;
		},
		intlDisplayName: () => nonEmpty(field("intlDisplayName"), "Qoder 国际版"),
		intlDisabledModels: () => stringList(field("intlDisabledModels")),
		intlModelContextWindows: () => numberMap(field("intlModelContextWindows")),
		intlModelAliases: () => stringMap(field("intlModelAliases")),
		codebuddyDisplayName: () => nonEmpty(field("codebuddyDisplayName"), "CodeBuddy"),
		codebuddyGlobalDisabledModels: () => stringList(field("codebuddyGlobalDisabledModels")),
		codebuddyCnDisabledModels: () => stringList(field("codebuddyCnDisabledModels")),
		codebuddyGlobalModelContextWindows: () => numberMap(field("codebuddyGlobalModelContextWindows")),
		codebuddyCnModelContextWindows: () => numberMap(field("codebuddyCnModelContextWindows")),
		codebuddyModelAliases: () => stringMap(field("codebuddyModelAliases")),
		minimaxEnabled: () => bool(field("minimaxEnabled"), true),
		minimaxRegion: () => field("minimaxRegion") === "global" ? "global" : "cn",
		minimaxDisplayName: () => nonEmpty(field("minimaxDisplayName"), "MiniMax Code"),
		minimaxGlobalDisabledModels: () => stringList(field("minimaxGlobalDisabledModels")),
		minimaxCnDisabledModels: () => stringList(field("minimaxCnDisabledModels")),
		minimaxGlobalModelContextWindows: () => numberMap(field("minimaxGlobalModelContextWindows")),
		minimaxCnModelContextWindows: () => numberMap(field("minimaxCnModelContextWindows")),
		minimaxModelAliases: () => stringMap(field("minimaxModelAliases"))
	};
}
/**
* Apply defaults to a parsed config.
*
* A one-shot snapshot of {@link liveConfig}, for a caller that genuinely wants
* the values as they are right now (a report, a test) rather than a view that
* keeps following edits. The running plugin does not use it: every option it
* hands downstream is a thunk, so a volatile edit is never missed.
*
* @param config - the parsed plugin config, possibly partial.
* @returns the same values with every default filled in.
*/
function resolveConfig(config) {
	const live = liveConfig(config);
	return {
		cnEnabled: live.cnEnabled(),
		intlEnabled: live.intlEnabled(),
		codebuddyEnabled: live.codebuddyEnabled(),
		codebuddyRegion: live.codebuddyRegion(),
		displayName: live.displayName(),
		maxSessions: live.maxSessions(),
		modelCacheTtlMs: live.modelCacheTtlMs(),
		defaultMaxTokens: live.defaultMaxTokens(),
		toolResultTimeoutMs: live.toolResultTimeoutMs(),
		catalogFetchTimeoutMs: live.catalogFetchTimeoutMs(),
		abortGraceMs: live.abortGraceMs(),
		coldMaxTurns: live.coldMaxTurns(),
		disabledModels: live.disabledModels(),
		modelContextWindows: live.modelContextWindows(),
		modelAliases: live.modelAliases(),
		defaultReasoningEffort: live.defaultReasoningEffort(),
		intlDisplayName: live.intlDisplayName(),
		intlDisabledModels: live.intlDisabledModels(),
		intlModelContextWindows: live.intlModelContextWindows(),
		intlModelAliases: live.intlModelAliases(),
		codebuddyDisplayName: live.codebuddyDisplayName(),
		codebuddyGlobalDisabledModels: live.codebuddyGlobalDisabledModels(),
		codebuddyCnDisabledModels: live.codebuddyCnDisabledModels(),
		codebuddyGlobalModelContextWindows: live.codebuddyGlobalModelContextWindows(),
		codebuddyCnModelContextWindows: live.codebuddyCnModelContextWindows(),
		codebuddyModelAliases: live.codebuddyModelAliases(),
		minimaxEnabled: live.minimaxEnabled(),
		minimaxRegion: live.minimaxRegion(),
		minimaxDisplayName: live.minimaxDisplayName(),
		minimaxGlobalDisabledModels: live.minimaxGlobalDisabledModels(),
		minimaxCnDisabledModels: live.minimaxCnDisabledModels(),
		minimaxGlobalModelContextWindows: live.minimaxGlobalModelContextWindows(),
		minimaxCnModelContextWindows: live.minimaxCnModelContextWindows(),
		minimaxModelAliases: live.minimaxModelAliases()
	};
}
function nonEmpty(value, fallback) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** A boolean with a default for a value the form has not supplied yet. */
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}
/**
* Keep only the positive, finite entries of a map.
*
* A window of zero or a negative number would be passed straight to the
* harness as a capacity, so invalid entries are dropped here rather than
* rejected — one bad row must not discard the user's other choices.
*/
function numberMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out[key] = entry;
	return out;
}
function stringMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" && entry.trim().length > 0) out[key] = entry.trim();
	return out;
}
//#endregion
//#region src/index.ts
/** Cordis plugin name; must match the `id` used by `cordis.patch.yml`. */
const name = "llm-qoder-cn";
/** The LLM registry must exist before an adapter can be registered on it. */
const inject = ["llm"];
/**
* Configuration namespace: the profile entry id this plugin is mounted under.
* The settings service and the configurable-provider directory both address the
* plugin by this key, and the exported {@link ConfigSchema} is the form source,
* so no page has to be registered by hand.
*/
const NS = "llm-qoder-cn";
/** Encoded-byte ceiling for one forwarded request image, before base64 expansion. */
const REQUEST_IMAGE_MAX_BYTES = 1048576;
/**
* Config fields whose value decides a registration shape rather than a runtime
* behaviour, and which therefore cannot be read lazily.
*
* The edition switches decide which routes exist at all; the two display names
* are copied into the picker directory. Everything else is read where it is
* used, so a change to these fields is the only thing that needs a republish.
*/
const STRUCTURAL_FIELDS = /* @__PURE__ */ new Set([
	"cnEnabled",
	"intlEnabled",
	"codebuddyEnabled",
	"minimaxEnabled",
	"displayName",
	"intlDisplayName",
	"codebuddyDisplayName",
	"minimaxDisplayName"
]);
/** The configurable-provider directory rows for the enabled editions. */
function directoryFor(live) {
	const rows = [];
	if (live.cnEnabled()) rows.push({
		provider: QODER_PROVIDER,
		displayName: live.displayName(),
		settingsNs: NS,
		settingsPath: []
	});
	if (live.intlEnabled()) rows.push({
		provider: QODER_INTL_PROVIDER,
		displayName: live.intlDisplayName(),
		settingsNs: NS,
		settingsPath: []
	});
	if (live.codebuddyEnabled()) rows.push({
		provider: CODEBUDDY_PROVIDER,
		displayName: live.codebuddyDisplayName(),
		settingsNs: NS,
		settingsPath: []
	});
	if (live.minimaxEnabled()) rows.push({
		provider: MINIMAX_PROVIDER,
		displayName: live.minimaxDisplayName(),
		settingsNs: NS,
		settingsPath: []
	});
	return rows;
}
/**
* The plugin's configuration schema, re-exported under the name the loader
* looks for. DSH reads `runtime.Config` off the plugin fiber to build the
* settings page, so this must stay the exported `Config` binding.
*
* Every field is `.volatile()`, which is what makes the namespace appear in
* `settings.describe()` at all — see the note on {@link ConfigSchema}.
*/
const Config = Config$1;
/**
* Mount the adapter for the lifetime of the plugin.
*
* @param ctx - the plugin's cordis context.
* @param config - parsed plugin config, whose volatile fields arrive as
*   references. {@link liveConfig} wraps them as thunks the adapter reads where
*   it uses them, so an edit applies without this function running again; an
*   empty object is a valid deployment.
*/
function apply(ctx, config) {
	const live = liveConfig(config);
	let attachments;
	let filesystem;
	/**
	* Everything both editions share.
	*
	* Images reach the inner model only through the host attachment store, so
	* this stays a lazy lookup. An unmounted store leaves the adapter with no
	* reader, and images degrade to the harness's own handle text instead of
	* failing the turn — which is also why `attachments` is not a hard inject:
	* the provider routes must register even on a deployment without one.
	*/
	const shared = {
		maxSessions: live.maxSessions,
		modelCacheTtlMs: live.modelCacheTtlMs,
		toolResultTimeoutMs: live.toolResultTimeoutMs,
		abortGraceMs: live.abortGraceMs,
		coldMaxTurns: live.coldMaxTurns,
		catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
		defaultMaxTokens: live.defaultMaxTokens,
		defaultReasoningEffort: live.defaultReasoningEffort,
		readImage: (ref, signal) => {
			const store = attachments;
			if (store === void 0) return Promise.resolve(void 0);
			return store.readImageRequest(ref, {
				width: ref.width,
				height: ref.height,
				maxBytes: REQUEST_IMAGE_MAX_BYTES
			}, signal).then((image) => ({
				bytes: image.data,
				mediaType: image.mediaType
			}));
		},
		/**
		* Where the model can find the image on disk. Pixels let it describe the
		* picture; this path lets a "modify and save it" turn act on the file
		* instead of searching the workspace for something that was never there.
		*/
		imagePath: (ref) => {
			const store = attachments;
			if (store === void 0) return void 0;
			const hostPath = store.imageHostPath(ref);
			if (hostPath === void 0) return void 0;
			return filesystem?.processPathFromHostPath?.(hostPath) ?? hostPath;
		}
	};
	/**
	* One adapter per provider.
	*
	* Separate instances, not one instance on several routes: each carries its
	* own catalog, warm sessions, account reading and user choices, so a request
	* can never be resolved against another provider's catalog.
	*/
	const adapters = {
		cn: new QoderAdapter({
			...shared,
			brand: "cn",
			displayName: live.displayName,
			disabledModels: live.disabledModels,
			modelContextWindows: live.modelContextWindows,
			modelAliases: live.modelAliases
		}),
		global: new QoderAdapter({
			...shared,
			brand: "global",
			displayName: live.intlDisplayName,
			disabledModels: live.intlDisabledModels,
			modelContextWindows: live.intlModelContextWindows,
			modelAliases: live.intlModelAliases
		}),
		codebuddy: new CodeBuddyAdapter({
			maxSessions: live.maxSessions,
			modelCacheTtlMs: live.modelCacheTtlMs,
			catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
			toolResultTimeoutMs: live.toolResultTimeoutMs,
			abortGraceMs: live.abortGraceMs,
			defaultMaxTokens: live.defaultMaxTokens,
			defaultReasoningEffort: live.defaultReasoningEffort,
			displayName: live.codebuddyDisplayName,
			region: live.codebuddyRegion,
			disabledModels: (region) => region === "cn" ? live.codebuddyCnDisabledModels() : live.codebuddyGlobalDisabledModels(),
			modelContextWindows: (region) => region === "cn" ? live.codebuddyCnModelContextWindows() : live.codebuddyGlobalModelContextWindows(),
			modelAliases: live.codebuddyModelAliases,
			readImage: shared.readImage,
			imagePath: shared.imagePath
		}),
		minimax: new MinimaxAdapter({
			maxSessions: live.maxSessions,
			modelCacheTtlMs: live.modelCacheTtlMs,
			catalogFetchTimeoutMs: live.catalogFetchTimeoutMs,
			toolResultTimeoutMs: live.toolResultTimeoutMs,
			abortGraceMs: live.abortGraceMs,
			defaultMaxTokens: live.defaultMaxTokens,
			defaultReasoningEffort: live.defaultReasoningEffort,
			displayName: live.minimaxDisplayName,
			region: live.minimaxRegion,
			disabledModels: (region) => region === "cn" ? live.minimaxCnDisabledModels() : live.minimaxGlobalDisabledModels(),
			modelContextWindows: (region) => region === "cn" ? live.minimaxCnModelContextWindows() : live.minimaxGlobalModelContextWindows(),
			modelAliases: live.minimaxModelAliases,
			readImage: shared.readImage,
			imagePath: shared.imagePath
		})
	};
	ctx.inject(["attachments"], (scope) => {
		attachments = scope.attachments;
		scope.effect(() => () => {
			attachments = void 0;
		}, "llm-qoder-cn.attachments");
	});
	ctx.inject(["fs"], (scope) => {
		filesystem = scope.fs;
		scope.effect(() => () => {
			filesystem = void 0;
		}, "llm-qoder-cn.fs");
	});
	const routes = {};
	let directory;
	const enabled = (id) => {
		if (id === "cn") return live.cnEnabled();
		if (id === "global") return live.intlEnabled();
		if (id === "minimax") return live.minimaxEnabled();
		return live.codebuddyEnabled();
	};
	/**
	* Bring the registered routes and the picker directory in line with the
	* current switches and labels.
	*
	* `registerAdapter` refuses an empty provider list, which is why a disabled
	* provider is *not registered* instead of being registered and then hidden:
	* the route itself has to disappear so no request can reach it and no model
	* list is offered for it. Turning it back on registers a fresh handle.
	*/
	const syncRegistration = () => {
		for (const brand of BRANDS) {
			const current = routes[brand.id];
			if (enabled(brand.id) && current === void 0) routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id]);
			else if (!enabled(brand.id) && current !== void 0) {
				current();
				delete routes[brand.id];
			}
		}
		const entries = directoryFor(live);
		if (entries.length === 0) {
			directory?.();
			directory = void 0;
		} else if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
	};
	syncRegistration();
	/**
	* React to a structural config edit.
	*
	* A volatile-only edit does not re-run `apply()`, so this is the only place
	* the route set, the picker labels and the enabled editions can follow it.
	*/
	ctx.on("loader/volatile-update", (paths) => {
		if (!paths.some((path) => STRUCTURAL_FIELDS.has(String(path[0])))) return;
		try {
			syncRegistration();
		} catch (error) {
			ctx.logger?.warn(`llm-qoder-cn: 重新发布模型分组失败：${String(error)}`);
		}
	});
	ctx.effect(() => () => {
		adapters.cn.close();
		adapters.global.close();
		adapters.codebuddy.close();
		adapters.minimax.close();
	}, "llm-qoder-cn.sessions");
	ctx.effect(() => () => {
		stopSetup();
		stopMinimaxSetup();
	}, "llm-qoder-cn.setup");
	ctx.inject(["webServer"], (scope) => {
		const server = scope.webServer;
		if (server === void 0) return;
		scope.effect(() => server.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: (req, res) => {
				handleApi(req, res, adapters);
			}
		}), "llm-qoder-cn: settings api");
		ctx.logger?.info(`llm-qoder-cn: 设置接口已挂载于 ${API_PREFIX}`);
	});
}
//#endregion
export { API_PREFIX, BRANDS, CN_BRAND, CODEBUDDY_BRAND, CODEBUDDY_DEFAULT_CONTEXT_WINDOW, CODEBUDDY_DEFAULT_MAX_TOKENS, CODEBUDDY_PROVIDER, CodeBuddyAccountReader, CodeBuddyAdapter, CodeBuddyAuth, CodeBuddyCatalog, CodeBuddySession, CodeBuddySessionManager, Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_USAGE_CACHE_TTL_MS, DEFAULT_USAGE_TIMEOUT_MS, GLOBAL_BRAND, MINIMAX_DEFAULT_CONTEXT_WINDOW, MINIMAX_DEFAULT_MAX_TOKENS, MINIMAX_PROVIDER, MINIMAX_USAGE_CACHE_TTL_MS, MODEL_ALIASES, MinimaxAcp, MinimaxAdapter, MinimaxAuth, MinimaxCatalog, MinimaxCliSetup, MinimaxRegionBlockedError, MinimaxSession, MinimaxSessionManager, NARROW_CHARS_PER_TOKEN, QODER_INTL_PROVIDER, QODER_MODELS, QODER_PROVIDER, QoderAdapter, QoderModelCatalog, QoderSession, QoderSessionManager, QoderUsage, SCRIPT_NAME, ToolResultPairing, WIDE_CHARS_PER_TOKEN, apply, brandProfile, buildRows, cliContextWindow, codeBuddyColdStream, codeBuddyEnvironment, countWideChars, estimateTextTokens, fetchCodeBuddyQuota, handleApi, hostMcpToolName, inject, invalidateMinimaxRegionAccess, invalidateMinimaxUsage, isBrandId, isHostMcpTool, isSetupMode, isWideChar, liveConfig, loadCodeBuddySdk, loadSdk, minimaxAuthStatePath, minimaxCliCommand, minimaxColdStream, minimaxDataDir, minimaxHostBelongsToOtherRegion, minimaxModelsFromConfigOptions, minimaxRegionBlockMessage, minimaxRegionBlocked, minimaxRegionBlockedCached, minimaxUsage, minimaxUsageFromParts, name, parseCodeBuddyQuota, pickContextWindow, priceFactorOf, readLive, readLiveOptional, readMinimaxSetupStatus, readSetupStatus, resolveCodeBuddyModelId, resolveConfig, resolveMinimaxCli, resolveMinimaxModelId, resolveQoderModelId, setupScriptPath, startMinimaxSetup, startSetup, stopMinimaxSetup, stopSetup, toCodeBuddyModel };
