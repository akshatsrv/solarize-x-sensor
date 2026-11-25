const byId = id => document.getElementById(id);
const form = byId('register');
const button = byId('register-submit');
const notice = byId('register-message');

form.onsubmit = async event => {
  event.preventDefault();
  const password = byId('register-password').value;
  notice.classList.remove('error');
  if (password !== byId('register-confirm').value) {
    notice.textContent = 'The passwords do not match.';
    notice.classList.add('error');
    return;
  }
  button.disabled = true;
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(7000),
      body: JSON.stringify({
        username: byId('register-user').value.trim(), invitation: byId('register-invite').value.trim(), password,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not activate your account.');
    form.reset();
    form.hidden = true;
    notice.textContent = 'Account activated. Sign in with your new password.';
  } catch (error) {
    notice.textContent = error.message;
    notice.classList.add('error');
  } finally {
    button.disabled = false;
  }
};
