import { Command } from 'commander';
import { exec } from 'child_process';
import * as toml from 'toml';
import * as fs from 'fs';

const CONFIG_FILE = 'wrangler.toml';

function readConfig(configFile: string = CONFIG_FILE) {
	const config = toml.parse(fs.readFileSync(configFile, 'utf-8'));
	return config;
}

function debug(verbose: boolean, message: string) {
	if (verbose) {
		console.log(message);
	}
}

async function deploy(verbose: boolean, branch: string) {
	const config = readConfig(CONFIG_FILE);
	const workerName = `${branch}-${config.name}`;
	const command = `npm exec wrangler publish -- --name ${workerName}`;
	debug(verbose, command);
	exec(command, (error, stdout, stderr) => {
		if (error) {
			console.log(`worker deployment failed:\n${stderr}`);
		} else {
			const workerId = stdout
				.split('\n')
				.filter((line) => line.match(/.*Deployment ID:/))[0]
				.split(':')[1]
				.trim();
			console.log(`worker deployed successfully with id ${workerId}`);
		}
	});
}

async function remove(verbose: boolean, branch: string) {
	const config = readConfig(CONFIG_FILE);
	const workerName = `${branch}-${config.name}`;
	const command = `npm exec wrangler delete -- --name ${workerName}`;
	debug(verbose, command);
	exec(command, (_) => {
		console.log(`worker removed successfully`);
	});
}

async function main() {
	const program = new Command();

	program.version('0.0.1', '--version', 'output the current version');
	program
		.command('deploy')
		.option('-b, --branch <branch>', 'branch name')
		.option('-v, --verbose', 'verbose output', false)
		.action((options) => {
			deploy(options.verbose, options.branch);
		});
	program
		.command('remove')
		.option('-b, --branch <branch>', 'branch name')
		.option('-v, --verbose', 'verbose output', false)
		.action((options) => {
			remove(options.verbose, options.branch);
		});
	program.parse();
}

main();
