/*
 * Local-only Zero-Trust architecture simulation.
 *
 * This deliberately demonstrates controlled bootstrap, identity-bound roles,
 * password hashing, a short-lived MFA challenge, and an audit trail. It is NOT
 * production authentication: LocalStorage can be read, altered, or cleared by
 * anyone with access to the browser profile. A real government deployment
 * needs a server-side identity provider, hardware-backed MFA, audited APIs,
 * secure cookies, rate limiting, and server-owned authorization decisions.
 */
(function () {
  'use strict';

  const STORAGE = Object.freeze({
    securityState: 'dictRegion1.zeroTrust.securityState.v1',
    identities: 'dictRegion1.zeroTrust.identities.v1',
    audit: 'dictRegion1.zeroTrust.audit.v1',
    setupToken: 'dictRegion1.zeroTrust.setupToken.v1',
    pendingMfa: 'dictRegion1.zeroTrust.pendingMfa.v1',
    session: 'dictRegion1.zeroTrust.session.v1'
  });

  const ROLES = Object.freeze(['GlobalAdmin', 'Admin', 'Staff', 'OJT', 'GIP', 'Other']);
  const PROVISIONABLE_ROLES = Object.freeze(['Admin', 'Staff', 'OJT', 'GIP', 'Other']);
  const RESTRICTED_ACCESS_LEVELS = Object.freeze({
    OJT: 'OJT Access Level: Read-only project tracking',
    GIP: 'GIP Access Level: Basic data entry',
    Other: 'General Access Level: Public information directory'
  });
  const PASSWORD_ITERATIONS = 150000;
  const MFA_LIFETIME_MS = 5 * 60 * 1000;
  const MFA_MAX_ATTEMPTS = 5;
  const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,47}$/;

  const views = Object.freeze({
    locked: document.getElementById('lockedStateView'),
    setup: document.getElementById('setupView'),
    login: document.getElementById('loginView'),
    mfa: document.getElementById('mfaView'),
    authenticated: document.getElementById('authenticatedView'),
    restricted: document.getElementById('restrictedView')
  });

  const notice = document.getElementById('message-banner');
  const setupForm = document.getElementById('setupView');
  const loginForm = document.getElementById('loginView');
  const mfaForm = document.getElementById('mfaView');
  const recoveryContainer = document.getElementById('recovery-container');
  const recoveryForm = document.getElementById('recovery-form');
  const forgotPasswordTrigger = document.getElementById('forgot-pwd-trigger');
  const backToLoginTrigger = document.getElementById('back-to-login');
  const provisioningPanel = document.getElementById('personnelProvisioning');
  const provisioningForm = document.getElementById('personnelProvisioningForm');
  const personnelDirectoryBody = document.getElementById('personnelDirectoryBody');
  const personnelDirectoryEmpty = document.getElementById('personnelDirectoryEmpty');
  const biometricScanner = document.querySelector('.biometric-scanner');

  // ─── Iconic Biometric Fingerprint (Static, Non-Randomized) ────────────────
  // Recreates the classic biometric scanner graphic with fixed, perfectly spaced
  // concentric arches, minutiae breaks, and scanner border with corner brackets.

  function buildFingerprint() {
    const svg = document.getElementById('fingerprintSvg');
    if (!svg) return;

    // Centre of the fingerprint core — positioned so the full oval fits in the border
    const cx = 180, cy = 228;
    const numRings = 12;

    // ── Path helper: quadratic‑bezier smooth poly-line ───────────────────────
    function pathToD(pts) {
      if (pts.length < 2) return '';
      let d = `M ${pts[0][0]} ${pts[0][1]}`;
      for (let k = 1; k < pts.length - 1; k++) {
        const mx = ((pts[k][0] + pts[k + 1][0]) / 2).toFixed(1);
        const my = ((pts[k][1] + pts[k + 1][1]) / 2).toFixed(1);
        d += ` Q ${pts[k][0]} ${pts[k][1]} ${mx} ${my}`;
      }
      d += ` L ${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
      return d;
    }

    // ── Generate points for one smooth teardrop/oval ring ────────────────────
    // The ring starts at the very bottom (angle = -π/2), sweeps clockwise all
    // the way around and ends back at the bottom, forming a closed oval.
    // The bottom half uses a slightly taller radius so it curves down naturally,
    // giving a realistic fingertip silhouette — no straight legs, no flat cuts.
    function getRingPoints(rIdx) {
      const rx = 10 + rIdx * 8.8;   // horizontal semi-axis
      const ryTop = 16 + rIdx * 11.4;  // vertical semi-axis — upper half
      const ryBot = 26 + rIdx * 9.8;   // vertical semi-axis — lower half (fuller bottom)
      const steps = 160;
      const points = [];

      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        // t: -π/2 → 3π/2  (full 360°, bottom → CCW → bottom again)
        const t = -Math.PI / 2 + u * Math.PI * 2;
        const sinT = Math.sin(t);
        const cosT = Math.cos(t);
        // Blend between ryTop and ryBot based on which half we're in
        // sinT > 0 → upper half (finger tip), sinT < 0 → lower half (finger base)
        const ry = sinT >= 0 ? ryTop : ryBot;
        const x = +(cx + rx * cosT).toFixed(1);
        const y = +(cy - ry * sinT).toFixed(1);
        points.push([x, y]);
      }
      return points;
    }

    // ── Fixed minutiae break positions (fraction of total steps) ─────────────
    // Breaks are distributed around the ring — NOT at the bottom (u ≈ 0/1)
    // so the smooth bottom curve is always kept intact.
    const ringBreaks = [
      [[0.38, 0.44]],                      // Ring  0: single break near top-right
      [[0.22, 0.28]],                      // Ring  1
      [[0.58, 0.64]],                      // Ring  2
      [[0.15, 0.21], [0.70, 0.76]],        // Ring  3
      [[0.32, 0.38]],                      // Ring  4
      [[0.50, 0.56], [0.82, 0.87]],        // Ring  5
      [[0.12, 0.18], [0.62, 0.68]],        // Ring  6
      [[0.40, 0.46]],                      // Ring  7
      [[0.24, 0.30], [0.74, 0.80]],        // Ring  8
      [[0.55, 0.61]],                      // Ring  9
      [[0.18, 0.24], [0.68, 0.73]],        // Ring 10
      [[0.36, 0.42], [0.80, 0.86]]         // Ring 11
    ];

    const paths = [];
    for (let i = 0; i < numRings; i++) {
      const pts = getRingPoints(i);
      const breaks = ringBreaks[i] || [];
      let startIdx = 0;

      for (const [bStart, bEnd] of breaks) {
        const sIdx = Math.floor(bStart * pts.length);
        const eIdx = Math.ceil(bEnd * pts.length);
        if (sIdx > startIdx + 2) {
          paths.push(pathToD(pts.slice(startIdx, sIdx)));
        }
        startIdx = eIdx;
      }
      // Remaining segment (wraps smoothly back to the starting bottom point)
      if (pts.length > startIdx + 2) {
        paths.push(pathToD(pts.slice(startIdx)));
      }
    }

    // ── Render into SVG ──────────────────────────────────────────────────────
    const NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';

    // ── ClipPath: grows downward as scan sweeps, reveals dark ridges ─────────
    const defs = document.createElementNS(NS, 'defs');
    const clipPath = document.createElementNS(NS, 'clipPath');
    clipPath.setAttribute('id', 'scanRevealClip');
    const clipRect = document.createElementNS(NS, 'rect');
    clipRect.setAttribute('x', '0');
    clipRect.setAttribute('y', '0');
    clipRect.setAttribute('width', '360');
    clipRect.setAttribute('height', '0');  // grows each frame
    clipPath.appendChild(clipRect);
    defs.appendChild(clipPath);
    svg.appendChild(defs);

    // ── LAYER 1: Gray base (always visible, unscanned look) ──────────────────
    const gGray = document.createElementNS(NS, 'g');
    gGray.setAttribute('class', 'fp-ridges fp-ridges-gray');
    for (const d of paths) {
      const el = document.createElementNS(NS, 'path');
      el.setAttribute('d', d);
      gGray.appendChild(el);
    }
    svg.appendChild(gGray);

    // ── LAYER 2: Dark revealed (clipped to region above scan line) ───────────
    const gDark = document.createElementNS(NS, 'g');
    gDark.setAttribute('class', 'fp-ridges fp-ridges-dark');
    gDark.setAttribute('clip-path', 'url(#scanRevealClip)');
    for (const d of paths) {
      const el = document.createElementNS(NS, 'path');
      el.setAttribute('d', d);
      gDark.appendChild(el);
    }
    svg.appendChild(gDark);

    // Keep the scanner frame in the HTML/CSS layer so it remains continuous.
    const border = document.createElementNS(NS, 'rect');
    border.setAttribute('x', '30');
    border.setAttribute('y', '32');
    border.setAttribute('width', '300');
    border.setAttribute('height', '396');
    border.setAttribute('rx', '20');
    border.setAttribute('class', 'fp-border');
    svg.appendChild(border);

    const corners = [
      'M 30 76 L 30 32 L 74 32',
      'M 286 32 L 330 32 L 330 76',
      'M 30 384 L 30 428 L 74 428',
      'M 286 428 L 330 428 L 330 384'
    ];
    for (const d of corners) {
      const el = document.createElementNS(NS, 'path');
      el.setAttribute('d', d);
      el.setAttribute('class', 'fp-corner');
      svg.appendChild(el);
    }

    // Expose clipRect so the animation loop can update it
    svg._scanClipRect = clipRect;
  }

  buildFingerprint();

  // ─── Animated scan line + clip-reveal (Top-to-Bottom Sweep) ───────────────
  function startDecorativeMotion() {
    if (!biometricScanner) return;

    const svg = document.getElementById('fingerprintSvg');
    const startedAt = performance.now();

    const animate = (now) => {
      const elapsedSeconds = (now - startedAt) / 1000;
      // 2.8s sweep — clamped to 21%→79% so the line stays inside the smaller frame
      // Inner frame: y=97 (≈21% of container) to y=363 (≈79% of container)
      const cycleProgress = (elapsedSeconds % 2.8) / 2.8;
      const scanPosition = 21 + (cycleProgress * 58);

      // Drive the CSS scan line position
      biometricScanner.style.setProperty('--fingerprint-scan-position', `${scanPosition.toFixed(2)}%`);

      // Drive the SVG clipRect height (in SVG viewBox units: 0–460)
      // scanPosition is % of container height (360px); SVG viewBox = 460 tall
      // svgY = (scanPosition / 100) * 460
      if (svg && svg._scanClipRect) {
        const scannerRect = biometricScanner.getBoundingClientRect();
        const svgRect = svg.getBoundingClientRect();
        const scanLineY = scannerRect.top + (scanPosition / 100) * scannerRect.height;
        const svgY = ((scanLineY - svgRect.top) / svgRect.height) * 460;
        svg._scanClipRect.setAttribute('height', Math.max(0, Math.min(460, svgY)).toFixed(1));
      }

    };

    const tick = () => animate(performance.now());
    tick();
    window.setInterval(tick, 16);
  }

  startDecorativeMotion();

  function showView(name) {
    recoveryContainer.style.display = 'none';
    loginForm.style.removeProperty('display');
    Object.entries(views).forEach(([viewName, view]) => {
      view.hidden = viewName !== name;
    });
  }

  function showRecoveryView() {
    Object.values(views).forEach((view) => { view.hidden = true; });
    loginForm.style.display = 'none';
    recoveryContainer.style.display = 'block';
    showNotice('', '');
    document.getElementById('recovery-username').focus();
  }

  function showLoginView() {
    recoveryForm.reset();
    showView('login');
  }

  function showNotice(message = '', type = '') {
    notice.textContent = message;
    notice.className = `notice${type ? ` is-${type}` : ''}`;
  }

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function getSecurityState() {
    return readJson(STORAGE.securityState, { initialized: false });
  }

  function getIdentities() {
    const identities = readJson(STORAGE.identities, []);
    return Array.isArray(identities) ? identities : [];
  }

  function isAdministrativeRole(role) {
    return role === 'GlobalAdmin' || role === 'Admin';
  }

  function renderPersonnelDirectory() {
    personnelDirectoryBody.replaceChildren();
    const provisionedPersonnel = getIdentities().filter((identity) =>
      identity.provisionedBy && identity.status === 'active'
    );

    personnelDirectoryEmpty.hidden = provisionedPersonnel.length > 0;
    provisionedPersonnel.forEach((identity) => {
      const row = document.createElement('tr');
      const values = [identity.displayName, identity.username, identity.role];
      values.forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });

      const statusCell = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = 'directory-status';
      statusBadge.textContent = 'Active';
      statusCell.appendChild(statusBadge);
      row.appendChild(statusCell);

      const actionCell = document.createElement('td');
      const resetButton = document.createElement('button');
      resetButton.type = 'button';
      resetButton.className = 'reset-password-button';
      resetButton.dataset.identityId = identity.id;
      resetButton.textContent = 'Reset Password';
      actionCell.appendChild(resetButton);

      const revokeButton = document.createElement('button');
      revokeButton.type = 'button';
      revokeButton.className = 'revoke-access-button';
      revokeButton.dataset.identityId = identity.id;
      revokeButton.textContent = 'Revoke Access';
      actionCell.appendChild(revokeButton);
      row.appendChild(actionCell);
      personnelDirectoryBody.appendChild(row);
    });
  }

  function hasPrimaryAdmin() {
    const state = getSecurityState();
    return state.initialized === true && getIdentities().some((identity) =>
      identity.role === 'GlobalAdmin' && identity.status === 'active'
    );
  }

  function secureRandomString(length) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    return Array.from(randomValues, (value) => alphabet[value % alphabet.length]).join('');
  }

  function issueSetupToken() {
    const existing = sessionStorage.getItem(STORAGE.setupToken);
    if (existing && existing.length === 32) return existing;

    const token = secureRandomString(32);
    sessionStorage.setItem(STORAGE.setupToken, token);
    console.log(`[SECURITY] One-time Setup Token Generated: ${token}`);
    console.warn('[SECURITY] Test-only token: never use browser console delivery for production setup credentials.');
    return token;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function hashPassword(password, saltBase64) {
    const encoder = new TextEncoder();
    const salt = saltBase64 ? base64ToBytes(saltBase64) : crypto.getRandomValues(new Uint8Array(16));
    const passwordKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
      passwordKey,
      256
    );

    return { salt: bytesToBase64(salt), hash: bytesToBase64(new Uint8Array(bits)) };
  }

  function constantTimeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
    let result = 0;
    for (let index = 0; index < left.length; index += 1) {
      result |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return result === 0;
  }

  function normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
  }

  function sanitizeDisplayName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  function audit(event, details = {}) {
    const events = readJson(STORAGE.audit, []);
    const record = {
      id: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      event,
      ...details
    };
    const nextEvents = Array.isArray(events) ? [...events, record].slice(-200) : [record];
    localStorage.setItem(STORAGE.audit, JSON.stringify(nextEvents));
  }

  function saveTestSession(identity) {
    sessionStorage.setItem(STORAGE.session, JSON.stringify({
      identityId: identity.id,
      username: identity.username,
      displayName: identity.displayName,
      role: identity.role,
      authenticatedAt: new Date().toISOString(),
      assurance: 'Password + simulated MFA'
    }));
  }

  function getVerifiedSessionIdentity() {
    const session = readJsonFromSession(STORAGE.session);
    if (!session) return null;

    const identity = getIdentities().find((candidate) =>
      candidate.id === session.identityId &&
      candidate.username === session.username &&
      candidate.role === session.role &&
      candidate.status === 'active'
    );

    return identity && ROLES.includes(identity.role) ? identity : null;
  }

  function clearPendingMfa() {
    sessionStorage.removeItem(STORAGE.pendingMfa);
  }

  function getPendingMfa() {
    try {
      const challenge = JSON.parse(sessionStorage.getItem(STORAGE.pendingMfa));
      if (!challenge || Date.now() > challenge.expiresAt || challenge.attempts >= MFA_MAX_ATTEMPTS) {
        clearPendingMfa();
        return null;
      }
      return challenge;
    } catch {
      clearPendingMfa();
      return null;
    }
  }

  function issueMfaChallenge(identity) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const challenge = {
      identityId: identity.id,
      code,
      expiresAt: Date.now() + MFA_LIFETIME_MS,
      attempts: 0
    };
    sessionStorage.setItem(STORAGE.pendingMfa, JSON.stringify(challenge));
    console.log(`[SECURITY] Simulated MFA code for ${identity.username}: ${code}`);
    console.warn('[SECURITY] Test-only MFA delivery. Production MFA must use a trusted out-of-band channel.');
    audit('mfa_challenge_issued', { identityId: identity.id, username: identity.username });
  }

  function renderAuthenticatedSession() {
    const identity = getVerifiedSessionIdentity();
    if (!identity) {
      sessionStorage.removeItem(STORAGE.session);
      return false;
    }

    if (Object.prototype.hasOwnProperty.call(RESTRICTED_ACCESS_LEVELS, identity.role)) {
      document.getElementById('restrictedIdentity').textContent = `A local restricted test session is active for ${identity.displayName}.`;
      document.getElementById('restrictedRole').textContent = identity.role;
      document.getElementById('restrictedAccessLevel').textContent = RESTRICTED_ACCESS_LEVELS[identity.role];
      showView('restricted');
      return true;
    }

    document.getElementById('sessionIdentity').textContent = `A local test session is active for ${identity.displayName}.`;
    document.getElementById('sessionUsername').textContent = identity.username;
    document.getElementById('sessionRole').textContent = identity.role;
    provisioningPanel.hidden = !isAdministrativeRole(identity.role);
    if (isAdministrativeRole(identity.role)) renderPersonnelDirectory();
    showView('authenticated');
    return true;
  }

  function initializeApplication() {
    if (renderAuthenticatedSession()) return;
    clearPendingMfa();

    if (hasPrimaryAdmin()) {
      showView('login');
      return;
    }

    issueSetupToken();
    showView('locked');
  }

  function validatePasswordPolicy(password) {
    return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
  }

  function isValidRecoveryCode(code) {
    return /^(?:\d{6}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/.test(code);
  }

  function hasRequiredBrowserCrypto() {
    return Boolean(window.crypto && crypto.subtle && crypto.getRandomValues && crypto.randomUUID);
  }

  document.getElementById('openSetupButton').addEventListener('click', () => {
    if (hasPrimaryAdmin()) {
      showNotice('System initialization is complete. Setup cannot be reopened.', 'error');
      showView('login');
      return;
    }
    showNotice('', '');
    showView('setup');
    document.getElementById('setupToken').focus();
  });

  document.getElementById('backToLockedButton').addEventListener('click', () => {
    showNotice('', '');
    showView('locked');
  });

  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!hasRequiredBrowserCrypto()) {
      showNotice('This browser context does not provide the required Web Crypto APIs. Use HTTPS or localhost for this simulation.', 'error');
      return;
    }
    if (hasPrimaryAdmin()) {
      showNotice('System initialization is already complete.', 'error');
      showView('login');
      return;
    }

    const formData = new FormData(setupForm);
    const token = String(formData.get('setupToken') || '').trim();
    const displayName = sanitizeDisplayName(formData.get('name'));
    const username = normalizeUsername(formData.get('username'));
    const password = String(formData.get('password') || '');
    const confirmPassword = String(formData.get('confirmPassword') || '');
    const storedToken = sessionStorage.getItem(STORAGE.setupToken);

    if (!constantTimeEqual(token, storedToken || '')) {
      audit('bootstrap_token_rejected');
      showNotice('Invalid setup token. Check the developer console and try again.', 'error');
      return;
    }
    if (!displayName || !USERNAME_PATTERN.test(username)) {
      showNotice('Use a valid name and a username with 3–48 lowercase letters, numbers, dots, underscores, or hyphens.', 'error');
      return;
    }
    if (!validatePasswordPolicy(password)) {
      showNotice('Password must be at least 12 characters and include uppercase, lowercase, and a number.', 'error');
      return;
    }
    if (!constantTimeEqual(password, confirmPassword)) {
      showNotice('The passwords do not match.', 'error');
      return;
    }

    const identities = getIdentities();
    if (identities.some((identity) => identity.username === username)) {
      showNotice('That username is already assigned to an identity.', 'error');
      return;
    }

    const passwordRecord = await hashPassword(password);
    const identity = {
      id: crypto.randomUUID(),
      username,
      displayName,
      role: 'GlobalAdmin',
      status: 'active',
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      passwordAlgorithm: `PBKDF2-SHA-256-${PASSWORD_ITERATIONS}`,
      createdAt: new Date().toISOString()
    };

    localStorage.setItem(STORAGE.identities, JSON.stringify([...identities, identity]));
    localStorage.setItem(STORAGE.securityState, JSON.stringify({
      initialized: true,
      initializedAt: new Date().toISOString(),
      primaryAdminId: identity.id,
      schemaVersion: 1
    }));
    sessionStorage.removeItem(STORAGE.setupToken);
    setupForm.reset();
    audit('system_initialized', { identityId: identity.id, username: identity.username, role: identity.role });
    document.getElementById('loginUsername').value = identity.username;
    showView('login');
    showNotice('Initialization complete. The primary administrator can now verify their identity.', 'success');
  });

  forgotPasswordTrigger.addEventListener('click', () => {
    if (!hasPrimaryAdmin()) {
      showNotice('Account recovery becomes available after secure initialization.', 'error');
      return;
    }
    showRecoveryView();
  });

  backToLoginTrigger.addEventListener('click', () => {
    showLoginView();
    showNotice('', '');
  });

  recoveryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = normalizeUsername(document.getElementById('recovery-username').value);
    const recoveryCode = document.getElementById('recovery-code').value.trim();
    const newPassword = document.getElementById('recovery-new-password').value;

    if (!USERNAME_PATTERN.test(username)) {
      showNotice('Enter a valid username before continuing.', 'error');
      return;
    }
    if (!isValidRecoveryCode(recoveryCode)) {
      showNotice('Enter a valid six-digit token or backup code in the XXXX-XXXX format.', 'error');
      return;
    }
    if (!validatePasswordPolicy(newPassword)) {
      showNotice('New password must be at least 12 characters and include uppercase, lowercase, and a number.', 'error');
      return;
    }

    const submitButton = recoveryForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Verifying account...';
    showNotice('Submitting account recovery request...', '');

    try {
      const response = await fetch('/api/auth/recover-account', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ username, recoveryCode, newPassword })
      });

      let responseData = {};
      try {
        responseData = await response.json();
      } catch {
        responseData = {};
      }

      const message = responseData.message || (response.ok
        ? 'Account recovery request verified.'
        : 'Account recovery could not be completed.');

      if (!response.ok) {
        showNotice(message, 'error');
        return;
      }

      audit('account_recovery_dispatch_succeeded', { username });
      showNotice(message, 'success');
      setTimeout(() => {
        showLoginView();
        showNotice('Recovery complete. Sign in using your updated credentials.', 'success');
      }, 2000);
    } catch {
      showNotice('Unable to reach the account recovery service. Please try again later.', 'error');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Update & Verify Account';
    }
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!hasRequiredBrowserCrypto()) {
      showNotice('This browser context does not provide the required Web Crypto APIs. Use HTTPS or localhost for this simulation.', 'error');
      return;
    }
    const formData = new FormData(loginForm);
    const username = normalizeUsername(formData.get('username'));
    const password = String(formData.get('password') || '');
    const identity = getIdentities().find((candidate) => candidate.username === username && candidate.status === 'active');

    if (!identity || !ROLES.includes(identity.role)) {
      audit('login_rejected', { username, reason: 'unknown_or_invalid_identity' });
      showNotice('Sign-in could not be completed.', 'error');
      return;
    }

    const derivedPassword = await hashPassword(password, identity.passwordSalt);
    if (!constantTimeEqual(derivedPassword.hash, identity.passwordHash)) {
      audit('login_rejected', { identityId: identity.id, username, reason: 'invalid_secret' });
      showNotice('Sign-in could not be completed.', 'error');
      return;
    }

    issueMfaChallenge(identity);
    loginForm.reset();
    showView('mfa');
    showNotice('Password verified. Enter the simulated MFA code from this browser’s developer console.', 'success');
    document.getElementById('mfaCode').focus();
  });

  mfaForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const challenge = getPendingMfa();
    const submittedCode = String(new FormData(mfaForm).get('mfaCode') || '').trim();

    if (!challenge) {
      showView('login');
      showNotice('The MFA challenge expired or was locked. Verify your password again.', 'error');
      return;
    }

    if (!constantTimeEqual(submittedCode, challenge.code)) {
      challenge.attempts += 1;
      sessionStorage.setItem(STORAGE.pendingMfa, JSON.stringify(challenge));
      audit('mfa_rejected', { identityId: challenge.identityId, attempts: challenge.attempts });
      if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
        clearPendingMfa();
        showView('login');
        showNotice('MFA challenge locked after too many attempts. Verify your password again.', 'error');
        return;
      }
      showNotice(`Incorrect MFA code. ${MFA_MAX_ATTEMPTS - challenge.attempts} attempt(s) remaining.`, 'error');
      return;
    }

    const identity = getIdentities().find((candidate) => candidate.id === challenge.identityId && candidate.status === 'active');
    if (!identity || !ROLES.includes(identity.role)) {
      clearPendingMfa();
      showView('login');
      showNotice('Identity authorization changed. Sign in again.', 'error');
      return;
    }

    clearPendingMfa();
    mfaForm.reset();
    saveTestSession(identity);
    audit('login_succeeded', { identityId: identity.id, username: identity.username, role: identity.role });
    renderAuthenticatedSession();
    showNotice('MFA verified. Test session established.', 'success');
  });

  provisioningForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!hasRequiredBrowserCrypto()) {
      showNotice('This browser context does not provide the required Web Crypto APIs. Use HTTPS or localhost for this simulation.', 'error');
      return;
    }

    const administrator = getVerifiedSessionIdentity();
    if (!administrator || !isAdministrativeRole(administrator.role)) {
      showNotice('Only an authenticated administrator may provision personnel.', 'error');
      renderAuthenticatedSession();
      return;
    }

    const formData = new FormData(provisioningForm);
    const displayName = sanitizeDisplayName(formData.get('name'));
    const username = normalizeUsername(formData.get('username'));
    const password = String(formData.get('password') || '');
    const role = String(formData.get('role') || '');

    if (!displayName || !USERNAME_PATTERN.test(username)) {
      showNotice('Use a valid personnel name and a unique username with 3–48 lowercase letters, numbers, dots, underscores, or hyphens.', 'error');
      return;
    }
    if (!validatePasswordPolicy(password)) {
      showNotice('Temporary password must be at least 12 characters and include uppercase, lowercase, and a number.', 'error');
      return;
    }
    if (!PROVISIONABLE_ROLES.includes(role)) {
      showNotice('Select an authorized personnel role.', 'error');
      return;
    }

    const identities = getIdentities();
    if (identities.some((identity) => identity.username === username)) {
      showNotice('That username is already assigned to an identity.', 'error');
      return;
    }

    const passwordRecord = await hashPassword(password);
    const identity = {
      id: crypto.randomUUID(),
      username,
      displayName,
      role,
      status: 'active',
      passwordSalt: passwordRecord.salt,
      passwordHash: passwordRecord.hash,
      passwordAlgorithm: `PBKDF2-SHA-256-${PASSWORD_ITERATIONS}`,
      createdAt: new Date().toISOString(),
      provisionedBy: administrator.id
    };

    localStorage.setItem(STORAGE.identities, JSON.stringify([...identities, identity]));
    audit('personnel_provisioned', {
      identityId: identity.id,
      username: identity.username,
      role: identity.role,
      provisionedBy: administrator.id
    });
    provisioningForm.reset();
    renderPersonnelDirectory();
    showNotice(`Personnel account provisioned for ${identity.displayName} with the ${identity.role} role.`, 'success');
  });

  personnelDirectoryBody.addEventListener('click', async (event) => {
    const resetButton = event.target.closest('.reset-password-button');
    const revokeButton = event.target.closest('.revoke-access-button');
    if (!resetButton && !revokeButton) return;

    const administrator = getVerifiedSessionIdentity();
    if (!administrator || !isAdministrativeRole(administrator.role)) {
      showNotice('Only an authenticated administrator may manage personnel access.', 'error');
      renderAuthenticatedSession();
      return;
    }

    const identityId = (resetButton || revokeButton).dataset.identityId;
    const identity = getIdentities().find((candidate) =>
      candidate.id === identityId && candidate.provisionedBy && candidate.status === 'active'
    );
    if (!identity) {
      renderPersonnelDirectory();
      showNotice('That personnel account is no longer active.', 'error');
      return;
    }

    if (resetButton) {
      const newPassword = window.prompt(`Enter a new temporary password for ${identity.username}:`);
      if (newPassword === null) return;
      if (!validatePasswordPolicy(newPassword)) {
        showNotice('Temporary password must be at least 12 characters and include uppercase, lowercase, and a number.', 'error');
        return;
      }

      const passwordRecord = await hashPassword(newPassword);
      const updatedIdentities = getIdentities().map((candidate) =>
        candidate.id === identity.id
          ? {
            ...candidate,
            passwordSalt: passwordRecord.salt,
            passwordHash: passwordRecord.hash,
            passwordAlgorithm: `PBKDF2-SHA-256-${PASSWORD_ITERATIONS}`,
            passwordUpdatedAt: new Date().toISOString()
          }
          : candidate
      );
      localStorage.setItem(STORAGE.identities, JSON.stringify(updatedIdentities));
      audit('personnel_password_reset', {
        identityId: identity.id,
        username: identity.username,
        resetBy: administrator.id
      });
      window.alert(`Password updated successfully for ${identity.username}.`);
      return;
    }

    if (!window.confirm(`Are you sure you want to revoke access for ${identity.username}?`)) return;

    const remainingIdentities = getIdentities().filter((candidate) => candidate.id !== identity.id);
    localStorage.setItem(STORAGE.identities, JSON.stringify(remainingIdentities));
    audit('personnel_access_revoked', {
      identityId: identity.id,
      username: identity.username,
      revokedBy: administrator.id
    });
    renderPersonnelDirectory();
    showNotice(`Access revoked for ${identity.username}.`, 'success');
  });

  document.getElementById('cancelMfaButton').addEventListener('click', () => {
    clearPendingMfa();
    mfaForm.reset();
    showView('login');
    showNotice('MFA challenge cancelled.', '');
  });

  function signOut() {
    const session = readJsonFromSession(STORAGE.session);
    if (session) audit('session_signed_out', { identityId: session.identityId, username: session.username });
    sessionStorage.removeItem(STORAGE.session);
    showView('login');
    showNotice('Test session ended.', '');
  }

  document.getElementById('signOutButton').addEventListener('click', signOut);
  document.getElementById('restrictedSignOutButton').addEventListener('click', signOut);

  function readJsonFromSession(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key));
    } catch {
      return null;
    }
  }

  initializeApplication();
}());
