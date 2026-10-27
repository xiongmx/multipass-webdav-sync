function fail(message) {
  throw new Error(message);
}

export async function request(url, options, label) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    fail(`${label} request failed before an HTTP response; it was not retried.`);
  }
  if (!response.ok) fail(`${label} was rejected with HTTP ${response.status}; the response body was not logged.`);
  return response;
}
