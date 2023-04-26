import { logger } from './logger.ts';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

async function genericAPI(
	url: string,
	path: string,
	method: ApiMethod = 'GET',
	headers: HeadersInit,
	body: object | null = null
) {
	const uri = `${url}/${path}`;
	logger.debug(`${method} ${uri}`);
	async function apiReturn(result: Response) {
		if (result.status == 204) {
			logger.debug(`${method} ${uri} succeeded with status ${result.status}`);
			return null;
		} else if (result.status == 404 && (method == 'DELETE' || method == 'GET')) {
			logger.debug(`${method} ${uri} succeeded with empty response`);
			return null;
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
	githubToken: string,
	path: string,
	method: ApiMethod = 'GET',
	body: object | null = null
) => {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github.v3+json',
		Authorization: `token ${githubToken}`
	};
	return genericAPI('https://api.github.com', path, method, headers, body);
};

const cloudflareAPI = (
	cloudflareToken: string,
	path: string,
	method: ApiMethod = 'GET',
	body: object | null = null
) => {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json',
		Authorization: `Bearer ${cloudflareToken}`
	};
	return genericAPI('https://api.cloudflare.com/client/v4', path, method, headers, body);
};

export type { ApiMethod };
export { genericAPI, githubAPI, cloudflareAPI };
