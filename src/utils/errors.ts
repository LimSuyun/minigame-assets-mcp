import axios, { AxiosError } from "axios";

export function handleApiError(error: unknown, service: string): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{ error?: { message?: string }; message?: string }>;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const data = axiosErr.response.data;
      const message = data?.error?.message || data?.message || axiosErr.message;

      switch (status) {
        case 400:
          return `Error [${service}]: Bad request - ${message}. Check your prompt or parameters.`;
        case 401:
          return `Error [${service}]: Authentication failed. Check your API key in environment variables.`;
        case 403:
          return `Error [${service}]: Permission denied. Ensure your API key has the required access.`;
        case 404:
          return `Error [${service}]: Resource not found. The model or endpoint may not exist.`;
        case 429:
          return `Error [${service}]: Rate limit exceeded. Wait before making more requests or check your quota.`;
        case 500:
        case 502:
        case 503:
          return `Error [${service}]: Server error (${status}). Try again later.`;
        default:
          return `Error [${service}]: Request failed with status ${status} - ${message}`;
      }
    } else if (axiosErr.code === "ECONNABORTED") {
      return `Error [${service}]: Request timed out. The generation may be taking too long. Try a simpler prompt.`;
    } else if (axiosErr.code === "ECONNREFUSED") {
      return `Error [${service}]: Connection refused. Check that the server is running at the configured URL.`;
    }
    return `Error [${service}]: Network error - ${axiosErr.message}`;
  }
  return `Error [${service}]: ${error instanceof Error ? error.message : String(error)}`;
}

export function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} environment variable is required. Set it in your .env file or environment.`
    );
  }
  return value;
}
