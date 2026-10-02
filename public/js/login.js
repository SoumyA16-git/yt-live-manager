/**
 * public/js/login.js — Client-side controller for login.html.
 * Separate file to strictly adhere to CSP script-src 'self' (PRD §19.2).
 */

const form = document.getElementById('login-form');
const errBox = document.getElementById('error-message');
const btn = document.getElementById('btn-login');

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Verifying credentials...';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        window.location.href = '/index.html';
      } else {
        errBox.textContent = data.error || 'Invalid username or password';
        errBox.style.display = 'block';
      }
    } catch (err) {
      errBox.textContent = 'Network or server communication error';
      errBox.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Sign In to Console`;
    }
  });
}
