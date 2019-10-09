/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check
'use strict';

const perf = require('./vs/base/common/performance');
const lp = require('./vs/base/node/languagePacks');

perf.mark('main:started');

const path = require('path');
const fs = require('fs');
const bootstrap = require('./bootstrap');
const paths = require('./paths');
// @ts-ignore
const product = require('../product.json');
// @ts-ignore
const app = require('electron').app;

// Enable portable support
const portable = bootstrap.configurePortable();

// Enable ASAR support
bootstrap.enableASARSupport();

// Set userData path before app 'ready' event
const args = parseCLIArgs();
const userDataPath = getUserDataPath(args);
app.setPath('userData', userDataPath);

// Update cwd based on environment and platform
setCurrentWorkingDirectory();

// Global app listeners
registerListeners();

/**
 * Support user defined locale: load it early before app('ready')
 * to have more things running in parallel.
 *
 * @type {Promise<import('./vs/base/node/languagePacks').NLSConfiguration>} nlsConfig | undefined
 */
let nlsConfigurationPromise = undefined;
const userDefinedLocale = getUserDefinedLocale();
const metaDataFile = path.join(__dirname, 'nls.metadata.json');

userDefinedLocale.then(locale => {
	if (locale && !nlsConfigurationPromise) {
		nlsConfigurationPromise = lp.getNLSConfiguration(product.commit, userDataPath, metaDataFile, locale);
	}
});

// Cached data
const nodeCachedDataDir = getNodeCachedDir();

// Configure command line switches
configureCommandlineSwitches(args);

// Load our code once ready
app.once('ready', function () {
	if (args['trace']) {
		// @ts-ignore
		const contentTracing = require('electron').contentTracing;

		const traceOptions = {
			categoryFilter: args['trace-category-filter'] || '*',
			traceOptions: args['trace-options'] || 'record-until-full,enable-sampling'
		};

		contentTracing.startRecording(traceOptions, () => onReady());
	} else {
		onReady();
	}
});

/**
 * Main startup routine
 *
 * @param {string | undefined} cachedDataDir
 * @param {import('./vs/base/node/languagePacks').NLSConfiguration} nlsConfig
 */
function startup(cachedDataDir, nlsConfig) {
	nlsConfig._languagePackSupport = true;

	process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);
	process.env['VSCODE_NODE_CACHED_DATA_DIR'] = cachedDataDir || '';

	// Load main in AMD
	perf.mark('willLoadMainBundle');
	require('./bootstrap-amd').load('vs/code/electron-main/main', () => {
		perf.mark('didLoadMainBundle');
	});
}

async function onReady() {
	perf.mark('main:appReady');

	try {
		const [cachedDataDir, locale] = await Promise.all([nodeCachedDataDir.ensureExists(), userDefinedLocale]);

		startup(cachedDataDir, await resolveNlsConfiguration(locale));
	} catch (error) {
		console.error(error);
	}
}

/**
 * @typedef	 {{ [arg: string]: any; '--'?: string[]; _: string[]; }} ParsedArgs
 *
 * @param {ParsedArgs} cliArgs
 */
function configureCommandlineSwitches(cliArgs) {

	// Default config
	let flagsConfig = {
		// Force pre-Chrome-60 color profile handling (for https://github.com/Microsoft/vscode/issues/51791)
		'disable-color-correct-rendering': true
	};

	const defaultFlagsConfigRaw =
		`// Allows to pass flags to Chromium's command line.
//
// If you see rendering issues in VSCode and have a better experience
// with software rendering, you can configure this by adding:
//
// 'disable-gpu': true
//
// NOTE: Changing this file requires a restart of VSCode.
//
// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT
{
	// Enabled by default by VSCode to resolve color issues in the renderer
	// See https://github.com/Microsoft/vscode/issues/51791 for details
	"disable-color-correct-rendering": true
}`;

	// Read or create the flags.json config file sync before app('ready')
	const flagsConfigPath = path.join(userDataPath, 'User', 'flags.json');
	try {
		flagsConfig = JSON.parse(stripComments(fs.readFileSync(flagsConfigPath).toString()));
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			try {
				fs.writeFileSync(flagsConfigPath, defaultFlagsConfigRaw);
			} catch (error) {
				console.error(error);
			}
		} else {
			console.warn(`Unable to read flags.json configuration file, falling back to defaults (${error})`);
		}
	}

	// Append each flag to Electron
	Object.keys(flagsConfig).forEach(flag => {
		const value = flagsConfig[flag];
		if (value === true || value === 'true') {
			if (flag === 'disable-gpu') {
				app.disableHardwareAcceleration(); // needs to be called explicitly
			}

			app.commandLine.appendArgument(flag);
		} else {
			app.commandLine.appendSwitch(flag, value);
		}
	});

	// Support JS Flags
	const jsFlags = getJSFlags(cliArgs);
	if (jsFlags) {
		app.commandLine.appendSwitch('js-flags', jsFlags);
	}
}

/**
 * @param {ParsedArgs} cliArgs
 * @returns {string}
 */
function getJSFlags(cliArgs) {
	const jsFlags = [];

	// Add any existing JS flags we already got from the command line
	if (cliArgs['js-flags']) {
		jsFlags.push(cliArgs['js-flags']);
	}

	// Support max-memory flag
	if (cliArgs['max-memory'] && !/max_old_space_size=(\d+)/g.exec(cliArgs['js-flags'])) {
		jsFlags.push(`--max_old_space_size=${cliArgs['max-memory']}`);
	}

	return jsFlags.length > 0 ? jsFlags.join(' ') : null;
}

/**
 * @param {ParsedArgs} cliArgs
 *
 * @returns {string}
 */
function getUserDataPath(cliArgs) {
	if (portable.isPortable) {
		return path.join(portable.portableDataPath, 'user-data');
	}

	return path.resolve(cliArgs['user-data-dir'] || paths.getDefaultUserDataPath(process.platform));
}

/**
 * @returns {ParsedArgs}
 */
function parseCLIArgs() {
	const minimist = require('vscode-minimist');

	return minimist(process.argv, {
		string: [
			'user-data-dir',
			'locale',
			'js-flags',
			'max-memory'
		]
	});
}

function setCurrentWorkingDirectory() {
	try {
		if (process.platform === 'win32') {
			process.env['VSCODE_CWD'] = process.cwd(); // remember as environment variable
			process.chdir(path.dirname(app.getPath('exe'))); // always set application folder as cwd
		} else if (process.env['VSCODE_CWD']) {
			process.chdir(process.env['VSCODE_CWD']);
		}
	} catch (err) {
		console.error(err);
	}
}

function registerListeners() {

	/**
	 * Mac: when someone drops a file to the not-yet running VSCode, the open-file event fires even before
	 * the app-ready event. We listen very early for open-file and remember this upon startup as path to open.
	 *
	 * @type {string[]}
	 */
	const macOpenFiles = [];
	global['macOpenFiles'] = macOpenFiles;
	app.on('open-file', function (event, path) {
		macOpenFiles.push(path);
	});

	/**
	 * React to open-url requests.
	 *
	 * @type {string[]}
	 */
	const openUrls = [];
	const onOpenUrl = function (event, url) {
		event.preventDefault();

		openUrls.push(url);
	};

	app.on('will-finish-launching', function () {
		app.on('open-url', onOpenUrl);
	});

	global['getOpenUrls'] = function () {
		app.removeListener('open-url', onOpenUrl);

		return openUrls;
	};
}

/**
 * @returns {{ ensureExists: () => Promise<string | undefined> }}
 */
function getNodeCachedDir() {
	return new class {

		constructor() {
			this.value = this._compute();
		}

		async ensureExists() {
			try {
				await bootstrap.mkdirp(this.value);

				return this.value;
			} catch (error) {
				// ignore
			}
		}

		_compute() {
			if (process.argv.indexOf('--no-cached-data') > 0) {
				return undefined;
			}

			// IEnvironmentService.isBuilt
			if (process.env['VSCODE_DEV']) {
				return undefined;
			}

			// find commit id
			const commit = product.commit;
			if (!commit) {
				return undefined;
			}

			return path.join(userDataPath, 'CachedData', commit);
		}
	};
}

//#region NLS Support
/**
 * Resolve the NLS configuration
 *
 * @param {string | undefined} locale
 * @return {Promise<import('./vs/base/node/languagePacks').NLSConfiguration>}
 */
async function resolveNlsConfiguration(locale) {

	// First, we need to test a user defined locale. If it fails we try the app locale.
	// If that fails we fall back to English.
	if (locale && !nlsConfigurationPromise) {
		nlsConfigurationPromise = lp.getNLSConfiguration(product.commit, userDataPath, metaDataFile, locale);
	} else if (!nlsConfigurationPromise) {
		nlsConfigurationPromise = Promise.resolve(undefined);
	}

	// First, we need to test a user defined locale. If it fails we try the app locale.
	// If that fails we fall back to English.
	let nlsConfiguration = await nlsConfigurationPromise;
	if (!nlsConfiguration) {

		// Try to use the app locale. Please note that the app locale is only
		// valid after we have received the app ready event. This is why the
		// code is here.
		let appLocale = app.getLocale();
		if (!appLocale) {
			nlsConfiguration = { locale: 'en', availableLanguages: {} };
		} else {

			// See above the comment about the loader and case sensitiviness
			appLocale = appLocale.toLowerCase();

			nlsConfiguration = await lp.getNLSConfiguration(product.commit, userDataPath, metaDataFile, appLocale);
			if (!nlsConfiguration) {
				nlsConfiguration = { locale: appLocale, availableLanguages: {} };
			}
		}
	} else {
		// We received a valid nlsConfig from a user defined locale
	}

	return nlsConfiguration;
}

/**
 * @param {string} content
 * @returns {string}
 */
function stripComments(content) {
	const regexp = /("(?:[^\\"]*(?:\\.)?)*")|('(?:[^\\']*(?:\\.)?)*')|(\/\*(?:\r?\n|.)*?\*\/)|(\/{2,}.*?(?:(?:\r?\n)|$))/g;

	return content.replace(regexp, function (match, m1, m2, m3, m4) {
		// Only one of m1, m2, m3, m4 matches
		if (m3) {
			// A block comment. Replace with nothing
			return '';
		} else if (m4) {
			// A line comment. If it ends in \r?\n then keep it.
			const length_1 = m4.length;
			if (length_1 > 2 && m4[length_1 - 1] === '\n') {
				return m4[length_1 - 2] === '\r' ? '\r\n' : '\n';
			}
			else {
				return '';
			}
		} else {
			// We match a string
			return match;
		}
	});
}

/**
 * Language tags are case insensitive however an amd loader is case sensitive
 * To make this work on case preserving & insensitive FS we do the following:
 * the language bundles have lower case language tags and we always lower case
 * the locale we receive from the user or OS.
 *
 * @returns {Promise<string>}
 */
async function getUserDefinedLocale() {
	const locale = args['locale'];
	if (locale) {
		return locale.toLowerCase();
	}

	const localeConfig = path.join(userDataPath, 'User', 'locale.json');

	try {
		const content = stripComments(await bootstrap.readFile(localeConfig));

		const value = JSON.parse(content).locale;
		return value && typeof value === 'string' ? value.toLowerCase() : undefined;
	} catch (error) {
		// ignore
	}
}
//#endregion
