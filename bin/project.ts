import type { ILogObj } from 'tslog';

import { Command } from 'commander';
import { execSync } from 'child_process';
import { Logger } from 'tslog';
import git from 'isomorphic-git';

import * as fs from 'fs';
import * as dotenv from 'dotenv';

const cwd = process.cwd();

if (fs.existsSync(`${cwd}/.env`)) {
	dotenv.config({ path: `${process.cwd()}/.env` });
}

const MAX_DEPLOYMENTS = 5;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || null;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_REF = process.env.GITHUB_SHA || null;
const SVELTE_BUILD_DIR = '.svelte-kit/cloudflare';
const LOG_LEVELS = {
	silly: 0,
	trace: 1,
	debug: 2,
	info: 3,
	warn: 4,
	error: 5,
	fatal: 6
};

const logger: Logger<ILogObj> = new Logger({ name: 'worker', minLevel: LOG_LEVELS.info });

async function genericAPI(
	url: string,
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	headers: HeadersInit,
	body: object | null = null
) {
	const uri = `${url}/${path}`;
	logger.debug(`${method} ${uri}`);
	async function apiReturn(result: Response) {
		if (result.status == 204) {
			logger.debug(`${method} ${uri} succeeded with status ${result.status}`);
			return { result: [] };
		} else if (result.status == 404 && (method == 'DELETE' || method == 'GET')) {
			logger.debug(`${method} ${uri} succeeded with empty response`);
			return { result: [] };
		} else if (!result.ok) {
			logger.debug(`${method} ${uri} failed with status ${result.status}`);
			logger.debug(`${method} ${uri} failed with message ${result.statusText}`);
			throw new Error(`${method} ${uri} failed with status ${result.status}`);
		} else {
			const response = await result.json();
			return response;
		}
	}
	if (body != null) {
		const result = await fetch(uri, { method, headers, body: JSON.stringify(body) });
		return apiReturn(result);
	} else {
		const result = await fetch(uri, { method, headers });
		return apiReturn(result);
	}
}

const githubAPI = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	body: object | null = null
) => {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github.v3+json',
		Authorization: `token ${GITHUB_TOKEN}`
	};
	return genericAPI('https://api.github.com', path, method, headers, body);
};

const cloudflareAPI = (
	path: string,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
	body: object | null = null
) => {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`
	};
	return genericAPI('https://api.cloudflare.com/client/v4', path, method, headers, body);
};

function execute(command: string, mode: 'run' | 'exec' | 'cli' = 'exec'): string {
	const npm = `npm ${mode} --`;
	const cmd = `${mode == 'cli' ? '' : npm} ${command}`;
	try {
		logger.debug(`Executing '${cmd}'`);
		const output = execSync(cmd).toString();
		return output;
	} catch (error: any) {
		const { status } = error;
		logger.error(`Command execution failed with status ${status || 'interrupted'}`);
		throw new Error(`Failed to execute '${cmd}'`);
	}
}

const exec = (command: string): string => execute(command, 'exec');
const run = (command: string): string => execute(command, 'run');

async function deploy(
	repository: string,
	name: string,
	environment: string,
	head: string,
	maxDeployments: number
): Promise<void> {
	logger.debug('Entering deploy command handler');
	const allProjects = await cloudflareAPI(`accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects`);
	const projectsMatch = allProjects.result.filter((x: any) => x.name === name);
	if (projectsMatch.length === 0) {
		// create cloudflare pages project
		exec(`wrangler pages project create ${name} --production-branch ${head}`);
	}
	if (!fs.existsSync(SVELTE_BUILD_DIR)) {
		run('build');
	}
	const publish = exec(
		`wrangler pages publish ${SVELTE_BUILD_DIR} --project-name ${name} --branch ${environment} --commit-dirty true`
	);
	const publishUrl = `${publish.split(' ').at(-1)}`.trim();
	logger.debug(`Project deployed at url ${publishUrl}`);
	logger.debug(`Creating Github environment '${environment}' for repository '${repository}'`);
	await createGithubDeployment(repository, environment, publishUrl);
	await cleanGithubDeployments(repository, environment, maxDeployments);
	logger.debug('Exiting deploy command handler');
}

async function listGithubDeployments(repository: string, environment: string) {
	logger.debug(`Listing deployments for repository '${repository}', environment '${environment}'`);
	const query = `ref=${environment}&environment=${environment}`;
	const deployments = await githubAPI(`repos/${repository}/deployments?${query}`, 'GET');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	logger.debug(JSON.stringify(deployments, null, 2));
	const sortedDeployments = deployments.sort((x: any, y: any) => {
		const xDate = new Date(x.updated_at);
		const yDate = new Date(y.updated_at);
		xDate <= yDate;
	});
	return sortedDeployments;
}

async function getGithubDeployment(repository: string, environment: string) {
	logger.debug(`Creating Github deployment for environment '${environment}'`);
	const ref = GITHUB_REF != null ? GITHUB_REF : environment;
	const deployments = await listGithubDeployments(repository, ref);
	if (deployments.length > 0) {
		const deployment = deployments[0];
		logger.debug(`Found existing deployment with id ${deployment.id}`);
		return deployment.id;
	} else {
		const deployment = await githubAPI(`repos/${repository}/deployments`, 'POST', {
			ref: ref,
			environment: environment,
			required_contexts: [],
			transient_environment: true
		});
		logger.debug(`Created deployment with id ${deployment.id}`);
		return deployment.id;
	}
}

async function createGithubDeployment(repository: string, environment: string, url: string) {
	githubAPI(`repos/${repository}/environments/${environment}`, 'PUT', {
		wait_timer: 0,
		reviewers: null,
		deployment_branch_policy: null
	});
	const deploymentId = await getGithubDeployment(repository, environment);
	const deploymentStatus = await githubAPI(
		`repos/${repository}/deployments/${deploymentId}/statuses`,
		'POST',
		{
			state: 'success',
			environment_url: url,
			auto_inactive: true
		}
	);
	logger.debug(`Created deployment status with id '${deploymentStatus.id}'`);
}

async function cleanGithubDeployments(
	repository: string,
	environment: string,
	maxDeployments: number
): Promise<void> {
	logger.debug('Entering cleanGithubDeployments command handler');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sortedDeployments = await listGithubDeployments(repository, environment);
	logger.debug(`Found ${sortedDeployments.length} deployments for environment '${environment}'`);
	if (sortedDeployments.length > maxDeployments) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const extraDeployments = sortedDeployments.slice(0, sortedDeployments.length - maxDeployments);
		logger.debug(`Removing ${extraDeployments.length} deployments`);
		logger.debug(extraDeployments.map((x: any) => x.updated_at));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		extraDeployments.forEach(async (deployment: any) => {
			logger.debug(`Removing deployment '${deployment.id}': '${deployment.updated_at}'`);
			const inactive = { state: 'inactive' };
			await githubAPI(
				`repos/${repository}/deployments/${deployment.id}/statuses`,
				'POST',
				inactive
			);
			await githubAPI(`repos/${repository}/deployments/${deployment.id}`, 'DELETE');
			logger.debug(`Deployment '${deployment.id}' removed`);
		});
	}
}

async function clean(
	repository: string,
	environment: string,
	head: string,
	maxDeployments: number
): Promise<void> {
	logger.debug('Entering clean command handler');
	await cleanGithubDeployments(repository, environment, maxDeployments);
	if (environment != head) {
		await cleanGithubDeployments(repository, environment, 0);
		await githubAPI(`repos/${repository}/environments/${environment}`, 'DELETE');
	}
	logger.debug('Exiting clean command handler');
}

function checkConfig() {
	if (!GITHUB_TOKEN) {
		logger.fatal('GITHUB_TOKEN environment variable is not set');
		process.exit(1);
	}
	if (!CLOUDFLARE_API_TOKEN) {
		logger.fatal('CLOUDFLARE_API_TOKEN environment variable is not set');
		process.exit(1);
	}
	if (!CLOUDFLARE_ACCOUNT_ID) {
		logger.fatal('CLOUDFLARE_ACCOUNT_ID environment variable is not set');
		process.exit(1);
	}
}

async function main() {
	const branch = await git.currentBranch({ fs, dir: cwd });
	const origin = await git.getConfig({ fs, dir: cwd, path: 'remote.origin.url' });
	const repo = origin
		.replace('git@', '')
		.replace('https://', '')
		.split(':')
		.at(-1)
		.replace('.git', '');
	const project = repo.split('/').at(-1);
	const program = new Command();
	program
		.version('0.0.1', '--version', 'output the current version')
		.description('page deployment tool')
		.helpOption('-h, --help', 'output usage information')
		.option('-v, --verbose', 'verbose output', false)
		.option('-q, --quiet', 'quiet output (overrides verbose)', false)
		.option('-k, --insecure', 'disable ssl verification', false)
		.hook('preAction', (program, _) => {
			const isVerbose = program.opts()['verbose'];
			const isQuiet = program.opts()['quiet'];
			const isGithubAction = process.env.GITHUB_ACTIONS === 'true';
			const isInsecure = program.opts()['insecure'];
			if (isVerbose) logger.settings.minLevel = LOG_LEVELS.debug;
			if (isQuiet) logger.settings.minLevel = LOG_LEVELS.fatal;
			if (isGithubAction) logger.settings.minLevel = LOG_LEVELS.fatal;
			if (isInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		});
	program
		.command('deploy')
		.option('-r, --repository [repository]', 'github repository in <owner>/<repo> format', repo)
		.option('-n, --name [name]', 'project page name', project)
		.option('-e, --environment <environment>', 'environment', `${branch}`)
		.option('-h, --head [branch]', 'head branch', 'master')
		.option('-m, --max-deployments [deployments]', 'max deployments', `${MAX_DEPLOYMENTS}`)
		.action((options, _) => {
			// create cloudflare page deployment [y]
			// create github environment [y]
			// create github deployment for environment [y]
			// prune github deployments for environment [y]
			deploy(
				options.repository,
				options.name,
				options.environment,
				options.head,
				Number(options.maxDeployments)
			);
		});
	program
		.command('clean')
		.option('-r, --repository [repository]', 'github repository in <owner>/<repo> format', repo)
		.option('-n, --name [name]', 'project page name', project)
		.option('-e, --environment <environment>', 'environment', `${branch}`)
		.option('-h, --head [branch]', 'head branch', 'master')
		.option('-m, --max-deployments [deployments]', 'max deployments', `${MAX_DEPLOYMENTS}`)
		.action((options, _) => {
			// delete cloudflare page deployment [y]
			// prune github deployments for environment [y]
			// delete github environment when requested
			clean(options.repository, options.environment, options.head, Number(options.maxDeployments));
		});
	program.parse(process.argv);
}

checkConfig();
main();
