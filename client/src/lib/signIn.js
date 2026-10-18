// The Schoology sign-in lives in Settings (RemoteSignIn, #136): it opens the server's
// own Microsoft sign-in on this device. Every other "Log in to Schoology" button goes
// there; /settings#schoology-signin opens the sign-in at once.
export const SIGN_IN_PATH = '/settings#schoology-signin';
export const signInDeps = { go: (path) => window.location.assign(path) };
export const goToSignIn = () => signInDeps.go(SIGN_IN_PATH);
export const SIGN_IN_NOTE = 'Opens the sign-in in Settings, on this device: a phone works too.';
