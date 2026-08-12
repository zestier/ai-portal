// Default-deny environment for subprocesses that operate on project code.
// Keep this to non-secret process/toolchain plumbing; providers add the exact
// credentials they require through `overrides`.
export const SAFE_CHILD_ENV_NAMES = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'LANGUAGE',
	'LC_ALL',
	'LC_CTYPE',
	'TZ',
	'TERM',
	'TERM_PROGRAM',
	'TERM_PROGRAM_VERSION',
	'COLORTERM',
	'NO_COLOR',
	'FORCE_COLOR',
	'TMPDIR',
	'HOSTNAME',
	'CI',
	'NODE',
	'NODE_PATH',
	'NVM_DIR',
	'PNPM_HOME',
	'COREPACK_HOME',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_RUNTIME_DIR',
	'SSH_AUTH_SOCK',
	'SSH_AGENT_PID',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'NPM_CONFIG_CACHE',
	'YARN_CACHE_FOLDER',
	'BUN_INSTALL',
	'CARGO_HOME',
	'RUSTUP_HOME',
	'GOPATH',
	'GOMODCACHE',
	'GOROOT',
	'JAVA_HOME',
	'GRADLE_USER_HOME',
	'VIRTUAL_ENV',
	'PYENV_ROOT',
	'PIP_CACHE_DIR',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS'
] as const;

export function isolatedChildEnv(
	source: NodeJS.ProcessEnv = process.env,
	overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of SAFE_CHILD_ENV_NAMES) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return env;
}
