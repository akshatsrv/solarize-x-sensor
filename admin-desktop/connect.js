const byId = id => document.getElementById(id);
const form = byId('connection-form');
const address = byId('address');
const password = byId('secret');
const button = byId('connect');
const message = byId('message');
const toggle = byId('toggle-register');
const code = byId('invite-code');
const confirmation = byId('secret-confirm');
const localButton = byId('start-local');
const localStatus = byId('local-status');
const ownerForm = byId('local-owner-form');
const ownerPassword = byId('owner-secret');
const ownerConfirm = byId('owner-confirm');
const ownerButton = byId('create-owner');
let registering = false;

function setRegistration(enabled) {
  registering = enabled;
  byId('invite-field').hidden = byId('confirm-field').hidden = !enabled;
  code.disabled = confirmation.disabled = !enabled;
  code.required = confirmation.required = enabled;
  code.value = confirmation.value = '';
  password.minLength = enabled ? 12 : 0;
  password.maxLength = enabled ? 128 : 1024;
  password.autocomplete = enabled ? 'new-password' : 'off';
  byId('connection-title').textContent = enabled ? 'Activate your account' : 'Connect to server';
  byId('secret-label').textContent = enabled ? 'New password' : 'Password';
  button.textContent = enabled ? 'Activate and connect' : 'Connect';
  toggle.textContent = enabled ? 'Back to sign-in' : 'Activate invitation';
}

toggle.onclick = () => {
  if (button.disabled) return;
  setRegistration(!registering);
  password.value = '';
  message.textContent = '';
  byId('identity').focus();
};

function localNotice(text, failed = false) {
  localStatus.hidden = !text;
  localStatus.textContent = text;
  localStatus.classList.toggle('error', failed);
}

async function startLocal() {
  if (localButton.disabled || button.disabled || ownerButton.disabled) return;
  localButton.disabled = button.disabled = true;
  localNotice('Starting the local server and kiosk…');
  try {
    const result = await window.consoleConnection.local();
    if (result.error) throw new Error(result.error);
    setRegistration(false);
    address.value = result.address;
    byId('identity').value = 'owner';
    password.value = '';
    if (result.configured) {
      ownerForm.hidden = true;
      form.hidden = false;
      localNotice('Local server and kiosk are ready. Sign in with your local password.');
      password.focus();
    } else {
      ownerForm.reset();
      ownerForm.hidden = false;
      form.hidden = true;
      localNotice('Set a password for the local owner account to open the console.');
      ownerPassword.focus();
    }
  } catch (error) {
    localNotice(error.message, true);
  } finally {
    localButton.disabled = button.disabled = false;
  }
}

localButton.onclick = startLocal;
byId('owner-back').onclick = () => {
  if (ownerButton.disabled) return;
  ownerForm.reset();
  ownerForm.hidden = true;
  form.hidden = false;
  address.value = '';
  byId('identity').value = '';
  localNotice('');
  address.focus();
};
ownerForm.onsubmit = async event => {
  event.preventDefault();
  if (ownerButton.disabled) return;
  if (ownerPassword.value !== ownerConfirm.value) {
    localNotice('The passwords do not match.', true);
    return;
  }
  ownerButton.disabled = localButton.disabled = true;
  try {
    const result = await window.consoleConnection.activateLocalOwner(ownerPassword.value);
    if (result.error) throw new Error(result.error);
    ownerForm.reset();
    ownerForm.hidden = true;
    form.hidden = false;
    localNotice('');
  } catch (error) {
    localNotice(error.message, true);
  } finally {
    ownerButton.disabled = localButton.disabled = false;
  }
};

window.consoleConnection.defaults().then(async config => {
  if (config && !address.value) address.value = config.address;
  if (config?.preferLocal) await startLocal();
  else password.focus();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  if (registering && password.value !== confirmation.value) {
    message.textContent = 'The passwords do not match.';
    message.classList.add('error');
    return;
  }
  button.disabled = true;
  toggle.disabled = true;
  message.classList.remove('error');
  message.textContent = registering ? 'Activating account…' : 'Connecting to server…';
  try {
    const account = { address: address.value, username: byId('identity').value, password: password.value };
    if (registering) {
      const activation = await window.consoleConnection.register({ ...account, invitation: code.value });
      if (activation.error) throw new Error(activation.error);
      setRegistration(false);
      message.textContent = 'Account activated. Connecting…';
    }
    const result = await window.consoleConnection.connect(account);
    password.value = '';
    if (result.error) throw new Error(result.error);
    message.textContent = '';
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('error');
    password.focus();
  } finally {
    button.disabled = false;
    toggle.disabled = false;
  }
});
