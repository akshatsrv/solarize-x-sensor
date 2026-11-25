const byId = id => document.getElementById(id);
const form = byId('connection-form');
const address = byId('address');
const password = byId('secret');
const button = byId('connect');
const message = byId('message');
const toggle = byId('toggle-register');
const code = byId('invite-code');
const confirmation = byId('secret-confirm');
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

window.consoleConnection.defaults().then(config => {
  if (config && !address.value) address.value = config.address;
  password.focus();
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
