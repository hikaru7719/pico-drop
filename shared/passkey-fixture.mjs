// Chromium virtual authenticator; exercises the real WebAuthn signature verification.
export async function virtualPasskey(page) {
	const client = await page.context().newCDPSession(page);
	await client.send('WebAuthn.enable');
	await client.send('WebAuthn.addVirtualAuthenticator', {
		options: AUTHENTICATOR
	});
}

export async function registerPasskey(page) {
	await virtualPasskey(page);
	await page.evaluate(registerInBrowser);
}

async function registerInBrowser() {
	const options = await authPost('register/options', { name: 'Test Sender' });
	const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
	const credential = await navigator.credentials.create({ publicKey });
	await authPost('register/verify', credential.toJSON());
}

// Installed into API-only pages before evaluate(registerInBrowser).
export async function installAuthPost(page) {
	const helpers = [authFetch, authPost, loginAssertion, forgedStatus];
	await page.addScriptTag({
		content: helpers.map((fn) => fn.toString()).join('\n')
	});
}

async function authFetch(path, body) {
	return fetch('/api/auth/' + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

async function authPost(path, body) {
	const response = await authFetch(path, body);
	if (!response.ok) {
		throw new Error('Auth failed: ' + (await response.text()));
	}
	return response.json();
}

async function loginAssertion() {
	const options = await authPost('login/options');
	const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
	return (await navigator.credentials.get({ publicKey })).toJSON();
}

async function forgedStatus() {
	const forged = await loginAssertion();
	forged.response.signature = 'AA';
	return (await authFetch('login/verify', forged)).status;
}

export async function verifyPasskeySecurity(page) {
	return page.evaluate(securityInBrowser);
}

async function securityInBrowser() {
	await authPost('logout');
	const assertion = await loginAssertion();
	const { account } = await authPost('login/verify', assertion);
	const replay = (await authFetch('login/verify', assertion)).status;
	return { name: account.name, replay, forged: await forgedStatus() };
}

const AUTHENTICATOR = {
	protocol: 'ctap2',
	transport: 'internal',
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true
};
