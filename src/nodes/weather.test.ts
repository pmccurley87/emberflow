import { describe, expect, it } from 'vitest';
import { buildAdvisory, classifyWeather, describeWeatherCode } from './weather';
import { createDefaultRegistry } from './index';
import { createWeatherFlow } from '../flows/weather-flow';
import { validateFlow } from '../engine';

describe('weather advisory logic', () => {
  it('maps weather codes to descriptions', () => {
    expect(describeWeatherCode(0)).toBe('clear sky');
    expect(describeWeatherCode(63)).toBe('rain');
    expect(describeWeatherCode(1234)).toContain('unknown');
  });

  it('advises umbrella on high rain chance and warmth on cold', () => {
    const advisory = buildAdvisory({
      place: 'Belfast', temperatureC: 3, windKmh: 35, weatherCode: 61,
      maxC: 6, minC: 1, rainChancePct: 80,
    });
    expect(advisory.advice).toContain('umbrella');
    expect(advisory.advice).toContain('wind');
    expect(advisory.advice).toContain('warm');
    expect(advisory.headline).toBe('Belfast: 3°C, light rain');
  });

  it('gives the all-clear on mild conditions', () => {
    const advisory = buildAdvisory({
      place: 'Nice', temperatureC: 21, windKmh: 8, weatherCode: 0,
      maxC: 24, minC: 16, rainChancePct: 5,
    });
    expect(advisory.advice).toBe('no precautions needed');
  });
});

describe('classifyWeather severity', () => {
  it('flags severe on gale-strength wind (≥ 40 km/h)', () => {
    const result = classifyWeather(45, 10);
    expect(result.severity).toBe('severe');
    expect(result.reason).toContain('wind');
  });

  it('flags severe on high rain chance (≥ 70%)', () => {
    const result = classifyWeather(12, 85);
    expect(result.severity).toBe('severe');
    expect(result.reason).toContain('rain');
  });

  it('grades calm conditions as mild', () => {
    expect(classifyWeather(15, 20).severity).toBe('mild');
    // Boundaries are exclusive below the thresholds.
    expect(classifyWeather(39, 69).severity).toBe('mild');
  });
});

describe('weather flow', () => {
  it('registers the weather nodes alongside the login set', () => {
    const types = createDefaultRegistry(0).list().map((d) => d.type);
    expect(types).toEqual(
      expect.arrayContaining(['GeocodeCity', 'FetchForecast', 'SummarizeConditions', 'Result', 'ValidateCredentials']),
    );
  });

  it('validates cleanly against the default registry', () => {
    expect(validateFlow(createWeatherFlow(), createDefaultRegistry(0))).toEqual([]);
  });
});
