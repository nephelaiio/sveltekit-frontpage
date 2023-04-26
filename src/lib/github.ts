import { logger } from './logger.ts';
import { githubAPI } from './api.ts';

async function listGithubDeployments(githubToken: string, repository: string, environment: string) {
	logger.debug(`Listing deployments for repository '${repository}', environment '${environment}'`);
	const query = `ref=${environment}&environment=${environment}`;
	const deploymentRecords = await githubAPI(
		githubToken,
		`repos/${repository}/deployments?${query}`,
		'GET'
	);
	const deployments = deploymentRecords || [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sortedDeployments = deployments.sort((x: any, y: any) => {
		const xDate = new Date(x.updated_at);
		const yDate = new Date(y.updated_at);
		xDate <= yDate;
	});
	logger.debug(
		`Found ${sortedDeployments.length} deployments for repository '${repository}', environment '${environment}'`
	);
	return sortedDeployments;
}

async function initGithubDeployment(githubToken: string, repository: string, environment: string) {
	logger.debug(`Retrieving Github deployment for environment '${environment}'`);
	const deploymentRecords = await listGithubDeployments(githubToken, repository, environment);
	const deployments = deploymentRecords || [];
	if (deployments.length > 0) {
		const deployment = deployments[0];
		logger.debug(`Found existing deployment with id ${deployment.id}`);
		return deployment.id;
	} else {
		const deployment = await githubAPI(githubToken, `repos/${repository}/deployments`, 'POST', {
			ref: environment,
			environment: environment,
			required_contexts: [],
			transient_environment: true
		});
		if (!deployment) {
			logger.debug(`Unable to create deployment for repository ${repository}`);
			throw new Error(`Unable to create deployment for repository ${repository}`);
		} else {
			logger.debug(`Created deployment with id ${deployment.id}`);
		}
		return deployment.id;
	}
}

async function createGithubDeployment(
	githubToken: string,
	repository: string,
	environment: string,
	url: string
) {
	logger.debug(
		`Creating Github deployment for repository '${repository}', environment '${environment}'`
	);
	await githubAPI(githubToken, `repos/${repository}/environments/${environment}`, 'PUT', {
		wait_timer: 0,
		reviewers: null,
		deployment_branch_policy: null
	});
	const deploymentId = await initGithubDeployment(`${githubToken}`, repository, environment);
	logger.debug(`Created deployment with id '${deploymentId}'`);
	logger.debug(`Creating Github deployment status for deployment '${deploymentId}'`);
	const deploymentStatus = await githubAPI(
		githubToken,
		`repos/${repository}/deployments/${deploymentId}/statuses`,
		'POST',
		{
			state: 'success',
			environment_url: url,
			auto_inactive: true
		}
	);
	if (!deploymentStatus) {
		logger.debug(`Unable to create deployment status for deployment ${deploymentId}`);
		throw new Error(`Unable to create deployment status for deployment ${deploymentId}`);
	} else {
		logger.debug(`Created deployment status with id '${deploymentStatus.id}'`);
	}
}

async function cleanGithubDeployments(
	githubToken: string,
	repository: string,
	environment: string,
	maxDeployments: number
): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const allDeployments = await listGithubDeployments(githubToken, repository, environment);
	logger.debug(`Found ${allDeployments.length} deployments for environment '${environment}'`);
	if (allDeployments.length > maxDeployments) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const extraDeployments = allDeployments.slice(0, allDeployments.length - maxDeployments);
		logger.debug(`Removing ${extraDeployments.length} deployments`);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		for (const deployment of extraDeployments) {
			logger.debug(`Removing deployment '${deployment.id}': '${deployment.updated_at}'`);
			const inactive = { state: 'inactive' };
			await githubAPI(
				githubToken,
				`repos/${repository}/deployments/${deployment.id}/statuses`,
				'POST',
				inactive
			);
			await githubAPI(githubToken, `repos/${repository}/deployments/${deployment.id}`, 'DELETE');
			logger.debug(`Deployment '${deployment.id}' removed`);
		}
	}
}

const listRepos = () => 'TODO: list repos';

export { createGithubDeployment, cleanGithubDeployments, listRepos };
