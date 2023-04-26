import { Command } from 'commander';
import { execSync } from 'child_process';

import git from 'isomorphic-git';

import * as fs from 'fs';
import * as dotenv from 'dotenv';

import { logger, LOG_LEVELS } from '../src/lib/logger.ts';
import { createGithubDeployment, cleanGithubDeployments } from '../src/lib/github.ts';
import { cloudflareAPI, githubAPI } from '../src/lib/api.ts';

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || null;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_REF = process.env.GITHUB_SHA || null;

const cwd = process.cwd();

if (fs.existsSync(`${cwd}/.env`)) {
	dotenv.config({ path: `${process.cwd()}/.env` });
}

const MAX_DEPLOYMENTS = 5;
const SVELTE_BUILD_DIR = '.svelte-kit/cloudflare';

function execute(command: string, mode: 'run' | 'exec' | 'cli' = 'exec'): string {
	const npm = `npm ${mode} --`;
	const cmd = `${mode == 'cli' ? '' : npm} ${command}`;
	try {
		logger.debug(`Executing '${cmd}'`);
		const output = execSync(cmd).toString();
		return output;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
	maxDeployments: number,
	buildDir: string = SVELTE_BUILD_DIR,
	secrets: string[] = [],
	variables: string[] = []
): Promise<void> {
	logger.debug(`Deploying project ${name}, environment ${environment} from ${repository}`);
	const projectResults = await cloudflareAPI(
		`${CLOUDFLARE_API_TOKEN}`,
		`accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects`
	);
	const allProjects = projectResults || { result: [] };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const projectsMatch = allProjects.result.filter((x: any) => x.name === name);
	if (projectsMatch === null) {
		exec(`wrangler pages project create ${name} --production-branch ${head}`);
	}
	const publishCommand = `wrangler pages publish ${buildDir}`;
	const publishArguments = `--project-name ${name} --branch ${environment} --commit-dirty true`;
	const publishOutput = exec(`${publishCommand} ${publishArguments}`);
	const publishUrl = `${publishOutput.split(' ').at(-1)}`.trim();
	const envMap = (vars: string[]) =>
		vars.map((varName) => ({ name: varName, value: `${process.env[varName]}` }));
	await addPageVariables(name, environment, head, envMap(variables), envMap(secrets));
	await createGithubDeployment(`${GITHUB_TOKEN}`, repository, environment, publishUrl);
	await cleanGithubDeployments(`${GITHUB_TOKEN}`, repository, environment, maxDeployments);
	await cleanPagesDeployments(name, environment, maxDeployments);
	const projectType = environment == head ? 'Production' : 'Preview';
	logger.debug(`${projectType} deployment published at url ${publishUrl}`);
}

async function listPagesDeployments(
	cloudflareToken: string,
	cloudflareAccountId: string,
	page: string,
	environment: string | null = null
) {
	logger.debug(
		`Listing Cloudflare page deployments for project '${page}', environment ${environment}`
	);
	const deploymentResults = await cloudflareAPI(
		cloudflareToken,
		`accounts/${cloudflareAccountId}/pages/projects/${page}/deployments`
	);
	const rawDeployments = deploymentResults || { result: [] };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const environmentDeployments = rawDeployments.result.filter((x: any) => {
		const isTrigger = 'deployment_trigger' in x;
		const isMetadata = 'metadata' in x['deployment_trigger'];
		const isBranch = 'branch' in x['deployment_trigger']['metadata'];
		const branch =
			isTrigger && isMetadata && isBranch ? x['deployment_trigger']['metadata']['branch'] : null;
		return branch === environment;
	});
	const deployments = environment != null ? environmentDeployments : rawDeployments;
	const sortedDeployments = deployments.sort((x: any, y: any) => {
		const xDate = new Date(x.created_on);
		const yDate = new Date(y.created_on);
		xDate <= yDate;
	});
	logger.debug(
		`Found ${sortedDeployments.length} Cloudflare page deployments for project '${page}'`
	);
	return sortedDeployments;
}

async function cleanPagesDeployments(
	page: string,
	environment: string | null = null,
	maxDeployments: number
) {
	logger.debug('Clean Pages deployments');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const deployments = await listPagesDeployments(
		`${CLOUDFLARE_API_TOKEN}`,
		`${CLOUDFLARE_ACCOUNT_ID}`,
		page,
		environment
	);
	logger.debug(`Found ${deployments.length} deployments for environment '${environment}'`);
	if (deployments.length > 0) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const extraDeployments = deployments.slice(0, deployments.length - maxDeployments);
		logger.debug(`Removing ${extraDeployments.length} deployments`);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		for (const deployment of extraDeployments) {
			logger.debug(`Removing deployment '${deployment.id}/${deployment.created_on}'`);
			try {
				await cloudflareAPI(
					`accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${page}/deployments/${deployment.id}`,
					'DELETE'
				);
				logger.debug(`Deployment '${deployment.id}' removed`);
			} catch (error) {
				logger.debug(`Unable to remove deployment '${deployment.id}'`);
			}
		}
	}
}

async function addPageVariables(
	page: string,
	environment: string,
	head: string,
	variables: { name: string; value: string }[],
	secrets: { name: string; value: string }[]
) {
	logger.debug(`Adding variables '${Object.keys(variables)}' to project '${page}'`);
	logger.debug(`Adding secrets '${Object.keys(secrets)}' to project '${page}'`);
	const varMap = (vars: { name: string; value: string }[]) => {
		return vars
			.map((variable) => ({ [variable.name]: { value: variable.value } }))
			.reduce((a, x) => ({ ...a, ...x }), {});
	};
	const secretMap = (vars: { name: string; value: string }[]) => {
		return vars
			.map((variable) => ({ [variable.name]: { value: variable.value, type: 'secret_text' } }))
			.reduce((a, x) => ({ ...a, ...x }), {});
	};
	const configSection = (environment == head && 'production') || 'preview';
	const pageData = await cloudflareAPI(
		`${CLOUDFLARE_API_TOKEN}`,
		`accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${page}`
	);
	const baseData = { deployment_configs: pageData.deployment_configs };
	const patchData = {
		deployment_configs: {
			[configSection]: {
				compatibility_date: '2022-01-01',
				compatibility_flags: ['url_standard'],
				env_vars: { ...varMap(variables), ...secretMap(secrets) }
			}
		}
	};
	await cloudflareAPI(
		`${CLOUDFLARE_API_TOKEN}`,
		`accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${page}`,
		'PATCH',
		{
			...baseData,
			...patchData
		}
	);
}

async function clean(
	repository: string,
	name: string,
	environment: string,
	head: string,
	maxDeployments: number
): Promise<void> {
	const projectType = environment == head ? 'production' : 'preview';
	logger.debug(`Cleaning up ${projectType} environment ${environment} for project ${name}`);
	await cleanGithubDeployments(`${GITHUB_TOKEN}`, repository, environment, maxDeployments);
	await cleanPagesDeployments(name, environment, maxDeployments);
	if (environment != head) {
		logger.debug(`Destroying ${projectType} environment ${environment} for project ${name}`);
		await cleanGithubDeployments(`${GITHUB_TOKEN}`, repository, environment, 0);
		await cleanPagesDeployments(name, environment, 0);
		await githubAPI(`repos/${repository}/environments/${environment}`, 'DELETE');
		logger.debug(`Destroyed ${projectType} environment ${environment} for project ${name}`);
	}
	logger.debug(`Cleaned up ${projectType} environment ${environment} for project ${name}`);
}

async function checkEnvironment() {
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

async function checkRepository(
	repository: string,
	environment: string,
	head: string,
	operation: string
) {
	logger.debug('Validating source repository settings');
	const repo = await githubAPI(`${GITHUB_TOKEN}`, `repos/${repository}`, 'GET');
	if (!repo) {
		logger.fatal(`Repository '${repository}' not found`);
		process.exit(1);
	}
	const master = await githubAPI(`${GITHUB_TOKEN}`, `repos/${repository}/branches/${head}`, 'GET');
	if (!master) {
		logger.fatal(`Master branch '${head}' for repository '${repository}' not found`);
		process.exit(1);
	}
	if (operation == 'deploy') {
		const branch = await githubAPI(
			`${GITHUB_TOKEN}`,
			`repos/${repository}/branches/${environment}`,
			'GET'
		);
		if (!branch) {
			logger.fatal(`Deploy branch '${environment}' for repository '${repository}' not found`);
			process.exit(1);
		}
	}
	logger.debug('Source repository validation successful');
}

async function checkSecrets(secrets: string[]) {
	logger.debug('Checking secret variables');
	secrets.forEach((s) => {
		if (!process.env[s]) {
			logger.fatal(`Environment variable '${s}' is not set`);
			process.exit(1);
		}
	});
	logger.debug('Secret validation successful');
}

async function checkEnvVars(vars: string[]) {
	logger.debug('Checking environment variables');
	vars.forEach((v) => {
		if (!process.env[v]) {
			logger.fatal(`Environment variable '${v}' is not set`);
			process.exit(1);
		}
	});
	logger.debug('Environment validation successful');
}

async function main() {
	const branch = await git.currentBranch({ fs, dir: cwd });
	const origin = await git.getConfig({ fs, dir: cwd, path: 'remote.origin.url' });
	const repo = origin
		.replace('git@', '')
		.replace('https://', '')
		.replace('.git', '')
		.replace(':', '/')
		.split('/')
		.slice(-2)
		.join('/');
	const project = repo.split('/').at(-1);
	const program = new Command();
	const checks: Promise<void>[] = [];
	const collect = (value: string, previous: string[]) => previous.concat([value]);

	program
		.version('0.0.1', '--version', 'output the current version')
		.description('page deployment tool')
		.helpOption('-h, --help', 'output usage information')
		.option('-v, --verbose', 'verbose output', false)
		.option('-q, --quiet', 'quiet output (overrides verbose)', false)
		.option('-k, --insecure', 'disable ssl verification', false)
		.option('-r, --repository [repository]', 'github repository in <owner>/<repo> format', repo)
		.option('-e, --environment <environment>', 'environment', `${branch}`)
		.option('-h, --head [branch]', 'head branch', 'master')
		.hook('preAction', (program, _) => {
			const isVerbose = program.opts()['verbose'];
			const isQuiet = program.opts()['quiet'];
			const isInsecure = program.opts()['insecure'];
			if (isVerbose) logger.settings.minLevel = LOG_LEVELS.debug;
			if (isQuiet) logger.settings.minLevel = LOG_LEVELS.fatal;
			if (isInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
			const { repository, environment, head } = program.opts();
			logger.info(`Validating deployment parameters`);
			checks.push(checkEnvironment());
		});

	program
		.command('deploy')
		.option('-n, --name [name]', 'project page name', project)
		.option('-m, --max-deployments [deployments]', 'max deployments', `${MAX_DEPLOYMENTS}`)
		.option('-d, --directory [directory]', 'build directory', `${SVELTE_BUILD_DIR}`)
		.option('-s, --secret <secret>', 'page environment secret', collect, [])
		.option('-v, --variable <env>', 'page environment variable', collect, [])
		.action((options, _) => {
			const { repository, environment, head } = program.opts();
			checks.push(checkRepository(repository, environment, head, 'deploy'));
			checks.push(checkSecrets(options.secret));
			checks.push(checkEnvVars(options.variable));
			Promise.all(checks).then(() => {
				logger.info(`Creating deployment for repository '${repo}', environment '${environment}'`);
				run('build');
				deploy(
					repository,
					options.name,
					environment,
					head,
					Number(options.maxDeployments),
					options.directory,
					options.secret,
					options.variable
				);
			});
		});

	program
		.command('clean')
		.option('-n, --name [name]', 'project page name', project)
		.option('-m, --max-deployments [deployments]', 'max deployments', `${MAX_DEPLOYMENTS}`)
		.action((options, _) => {
			const { repository, environment, head } = program.opts();
			checks.push(checkRepository(repository, environment, head, 'clean'));
			Promise.all(checks).then(() => {
				logger.info(`Cleaning deployments for repository '${repo}'`);
				clean(repository, options.name, environment, head, Number(options.maxDeployments));
			});
		});
	program.parse(process.argv);
}

main();
