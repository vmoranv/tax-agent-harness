import { describe, expect, it } from 'vitest';
import { createAdapter } from '../src/provider/adapters.js';
import { resolveProvider } from '../src/provider/manager.js';
import { getPreset, listVendors, VENDOR_PRESETS } from '../src/provider/protocol.js';

describe('厂商预设表', () => {
  it('覆盖至少 40 个厂商', () => {
    expect(Object.keys(VENDOR_PRESETS).length).toBeGreaterThanOrEqual(40);
  });

  it('每个预设都有协议、baseUrl、默认模型', () => {
    for (const p of Object.values(VENDOR_PRESETS)) {
      expect(p.protocol).toBeTruthy();
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.defaultModel.length).toBeGreaterThan(0);
    }
  });

  it('只有 4 种协议（这是核心洞察：47 厂商只需 4 套实现）', () => {
    const protocols = new Set(Object.values(VENDOR_PRESETS).map((v) => v.protocol));
    expect(protocols.size).toBe(4);
    expect([...protocols].sort()).toEqual([
      'anthropic',
      'gemini',
      'openai-chat',
      'openai-responses',
    ]);
  });

  it('Anthropic 走原生协议，不是 OpenAI 兼容', () => {
    expect(getPreset('anthropic')?.protocol).toBe('anthropic');
  });

  it('Gemini 走原生协议', () => {
    expect(getPreset('gemini')?.protocol).toBe('gemini');
  });

  it('OpenAI 默认走 Responses API', () => {
    expect(getPreset('openai')?.protocol).toBe('openai-responses');
    expect(getPreset('openai-chat')?.protocol).toBe('openai-chat');
  });

  it('国内厂商都走 OpenAI 兼容', () => {
    for (const v of ['deepseek', 'zhipu', 'moonshot', 'qwen', 'minimax', 'doubao']) {
      expect(getPreset(v)?.protocol).toBe('openai-chat');
    }
  });

  it('本地部署都有本地地址', () => {
    for (const v of ['ollama', 'vllm', 'lmstudio', 'localai']) {
      expect(getPreset(v)?.baseUrl).toMatch(/localhost|127\.0\.0\.1/);
    }
  });

  it('listVendors 返回可用清单', () => {
    const list = listVendors();
    expect(list.length).toBeGreaterThanOrEqual(40);
    expect(list.find((v) => v.id === 'anthropic')?.label).toContain('Claude');
  });
});

describe('provider 解析', () => {
  it('按厂商预设自动选协议', () => {
    const r = resolveProvider({ vendor: 'deepseek', apiKey: 'k' });
    expect(r.protocol).toBe('openai-chat');
    expect(r.modelId).toBe('deepseek-chat');
  });

  it('Anthropic 解析出 anthropic 协议并带版本头', () => {
    const r = resolveProvider({ vendor: 'anthropic', apiKey: 'k' });
    expect(r.protocol).toBe('anthropic');
    expect(r.adapter.config.headers?.['anthropic-version']).toBe('2023-06-01');
  });

  it('显式 protocol 覆盖预设', () => {
    const r = resolveProvider({
      vendor: 'openai',
      protocol: 'openai-chat',
      apiKey: 'k',
    });
    expect(r.protocol).toBe('openai-chat');
  });

  it('显式 baseUrl / model 覆盖预设', () => {
    const r = resolveProvider({
      vendor: 'deepseek',
      baseUrl: 'https://my-proxy.example.com/v1',
      model: 'my-model',
      apiKey: 'k',
    });
    expect(r.adapter.config.baseUrl).toBe('https://my-proxy.example.com/v1');
    expect(r.modelId).toBe('my-model');
  });

  it('未知厂商报错并列出可用项', () => {
    expect(() => resolveProvider({ vendor: 'not-exist', apiKey: 'k' })).toThrow(/未知厂商/);
  });

  it('缺 baseUrl 时报错', () => {
    expect(() => resolveProvider({ apiKey: 'k' })).toThrow(/缺少 baseUrl/);
  });
});

describe('协议适配器', () => {
  const base = { baseUrl: 'http://localhost:1/v1', apiKey: 'k', model: 'm' };

  it('openai-chat 能构造模型', () => {
    const a = createAdapter('openai-chat', base);
    expect(a.protocol).toBe('openai-chat');
    expect(() => a.createModel()).not.toThrow();
  });

  it('openai-responses 能构造模型', () => {
    const a = createAdapter('openai-responses', { ...base, baseUrl: 'https://api.openai.com/v1' });
    expect(a.protocol).toBe('openai-responses');
    expect(() => a.createModel()).not.toThrow();
  });

  it('anthropic 能构造模型', () => {
    const a = createAdapter('anthropic', { ...base, baseUrl: 'https://api.anthropic.com' });
    expect(a.protocol).toBe('anthropic');
    expect(() => a.createModel()).not.toThrow();
  });

  it('gemini 能构造模型', () => {
    const a = createAdapter('gemini', {
      ...base,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
    expect(a.protocol).toBe('gemini');
    expect(() => a.createModel()).not.toThrow();
  });

  it('probe 在不可达时返回 ok:false 而不是抛错', async () => {
    const a = createAdapter('openai-chat', base);
    const r = await a.probe();
    expect(r.ok).toBe(false);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
