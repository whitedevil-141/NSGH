function redirectToLogin() {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('token_expiry');
    window.location.replace('login.html');
}

function requireDashboardToken() {
    const token = sessionStorage.getItem('token');
    const expiresAt = Number(sessionStorage.getItem('token_expiry'));
    if (!token || !Number.isFinite(expiresAt) || Date.now() >= expiresAt * 1000) {
        redirectToLogin();
        throw new Error('Your session has expired. Please sign in again.');
    }
    return token;
}

async function dashboardApiRequest(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${requireDashboardToken()}`);
    const response = await fetch((window.NSGH_API_BASE || 'https://api.nsghbd.com') + path, {
        ...options,
        headers
    });
    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const payload = await response.json();
            if (typeof payload.detail === 'string') message = payload.detail;
        } catch {
            // Keep the HTTP status when the server returns a non-JSON error.
        }
        if (response.status === 401) {
            redirectToLogin();
            message = 'Your session has expired or is invalid. Please sign in again.';
        }
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }
    return response;
}
