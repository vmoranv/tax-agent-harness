/**
 * axios 实例。
 *
 * 无登录态：身份由请求参数显式传递，权限由后端用例层判定。
 * 这里只做统一的错误规整。
 */

import axios, { AxiosError } from 'axios';

export const httpClient = axios.create({
  baseURL: '/',
  timeout: 120_000,
});

export function normalizeError(err: unknown): { status?: number; message: string } {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { error?: string; message?: string } | undefined;
    return {
      status: err.response?.status,
      message: data?.message ?? data?.error ?? err.message,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
