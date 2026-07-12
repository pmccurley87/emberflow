import type { NodeRegistry } from '../engine';

const WEATHER_CODES: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'dense drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  80: 'rain showers',
  81: 'rain showers',
  82: 'violent rain showers',
  95: 'thunderstorm',
  96: 'thunderstorm with hail',
  99: 'thunderstorm with heavy hail',
};

export function describeWeatherCode(code: number): string {
  return WEATHER_CODES[code] ?? `unknown conditions (code ${code})`;
}

export interface AdvisoryInput {
  place: string;
  temperatureC: number;
  windKmh: number;
  weatherCode: number;
  maxC: number;
  minC: number;
  rainChancePct: number;
}

export function buildAdvisory(input: AdvisoryInput) {
  const condition = describeWeatherCode(input.weatherCode);
  const advice: string[] = [];
  if (input.rainChancePct >= 50) advice.push('take an umbrella');
  if (input.windKmh >= 30) advice.push('expect strong wind');
  if (input.temperatureC <= 5) advice.push('dress warm');
  if (input.temperatureC >= 28) advice.push('stay hydrated');
  if (advice.length === 0) advice.push('no precautions needed');

  return {
    place: input.place,
    temperatureC: input.temperatureC,
    condition,
    headline: `${input.place}: ${Math.round(input.temperatureC)}°C, ${condition}`,
    range: `${Math.round(input.minC)}–${Math.round(input.maxC)}°C today, ${Math.round(input.rainChancePct)}% rain chance`,
    advice: advice.join('; '),
  };
}

export type WeatherSeverity = 'severe' | 'mild';

/**
 * Pure severity rule: severe when wind is at gale strength (≥ 40 km/h) or rain
 * is likely (≥ 70% chance), otherwise mild.
 */
export function classifyWeather(windKmh: number, rainChancePct: number): {
  severity: WeatherSeverity;
  reason: string;
} {
  if (windKmh >= 40) {
    return { severity: 'severe', reason: `high winds at ${Math.round(windKmh)} km/h` };
  }
  if (rainChancePct >= 70) {
    return { severity: 'severe', reason: `${Math.round(rainChancePct)}% chance of rain` };
  }
  return {
    severity: 'mild',
    reason: `winds ${Math.round(windKmh)} km/h, ${Math.round(rainChancePct)}% rain chance`,
  };
}

/**
 * Real-infrastructure nodes backed by the Open-Meteo public APIs
 * (keyless, CORS-enabled): geocoding + weather forecast.
 */
export function registerWeatherNodes(registry: NodeRegistry): void {
  registry.register(
    {
      type: 'GeocodeCity',
      label: 'Geocode City',
      description: 'Resolves a city name to coordinates via the Open-Meteo geocoding API.',
      category: 'http',
      traceKind: 'http',
      traceDetail: 'GET https://geocoding-api.open-meteo.com/v1/search?name={city}&count=1',
      // city is input-drivable (e.g. from an Input node); config is the fallback.
      inputSchema: {
        fields: [{ name: 'city', type: 'string' }],
      },
      configSchema: {
        fields: [{ name: 'city', type: 'string', required: true }],
      },
      outputSchema: {
        fields: [
          { name: 'place', type: 'string' },
          { name: 'country', type: 'string' },
          { name: 'latitude', type: 'number' },
          { name: 'longitude', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const city = String(ctx.input.city ?? '');
      if (!city) throw new Error('No city configured');
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`;
      ctx.log('info', `GET ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Geocoding failed: HTTP ${response.status}`);
      const data = (await response.json()) as {
        results?: Array<{ name: string; country: string; latitude: number; longitude: number }>;
      };
      const hit = data.results?.[0];
      if (!hit) throw new Error(`No location found for "${city}"`);
      ctx.log('info', `Resolved ${hit.name}, ${hit.country} → ${hit.latitude}, ${hit.longitude}`);
      return {
        place: hit.name,
        country: hit.country,
        latitude: hit.latitude,
        longitude: hit.longitude,
      };
    },
  );

  registry.register(
    {
      type: 'FetchForecast',
      label: 'Fetch Forecast',
      description: 'Fetches live current conditions and today’s outlook from the Open-Meteo forecast API.',
      category: 'http',
      traceKind: 'http',
      traceDetail:
        'GET https://api.open-meteo.com/v1/forecast?latitude&longitude&current=temperature_2m,wind_speed_10m,weather_code&daily=…&forecast_days=1',
      inputSchema: {
        fields: [
          { name: 'latitude', type: 'number', required: true },
          { name: 'longitude', type: 'number', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'temperatureC', type: 'number' },
          { name: 'windKmh', type: 'number' },
          { name: 'weatherCode', type: 'number' },
          { name: 'maxC', type: 'number' },
          { name: 'minC', type: 'number' },
          { name: 'rainChancePct', type: 'number' },
        ],
      },
    },
    async (ctx) => {
      const latitude = Number(ctx.input.latitude);
      const longitude = Number(ctx.input.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error('latitude/longitude missing or not numbers');
      }
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        '&current=temperature_2m,wind_speed_10m,weather_code' +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&timezone=auto&forecast_days=1';
      ctx.log('info', `GET ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Forecast failed: HTTP ${response.status}`);
      const data = (await response.json()) as {
        current: { temperature_2m: number; wind_speed_10m: number; weather_code: number };
        daily: {
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_probability_max: Array<number | null>;
        };
      };
      const output = {
        temperatureC: data.current.temperature_2m,
        windKmh: data.current.wind_speed_10m,
        weatherCode: data.current.weather_code,
        maxC: data.daily.temperature_2m_max[0],
        minC: data.daily.temperature_2m_min[0],
        rainChancePct: data.daily.precipitation_probability_max[0] ?? 0,
      };
      ctx.log('info', `Now ${output.temperatureC}°C, wind ${output.windKmh} km/h, code ${output.weatherCode}`);
      return output;
    },
  );

  registry.register(
    {
      type: 'SummarizeConditions',
      label: 'Summarize Conditions',
      description: 'Turns raw forecast numbers into a readable weather advisory.',
      category: 'logic',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'place', type: 'string', required: true },
          { name: 'temperatureC', type: 'number', required: true },
          { name: 'windKmh', type: 'number', required: true },
          { name: 'weatherCode', type: 'number', required: true },
          { name: 'maxC', type: 'number' },
          { name: 'minC', type: 'number' },
          { name: 'rainChancePct', type: 'number' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'range', type: 'string' },
          { name: 'advice', type: 'string' },
          { name: 'place', type: 'string' },
          { name: 'temperatureC', type: 'number' },
          { name: 'condition', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const advisory = buildAdvisory({
        place: String(ctx.input.place ?? 'Unknown'),
        temperatureC: Number(ctx.input.temperatureC),
        windKmh: Number(ctx.input.windKmh),
        weatherCode: Number(ctx.input.weatherCode),
        maxC: Number(ctx.input.maxC ?? ctx.input.temperatureC),
        minC: Number(ctx.input.minC ?? ctx.input.temperatureC),
        rainChancePct: Number(ctx.input.rainChancePct ?? 0),
      });
      ctx.log('info', advisory.headline);
      ctx.log('info', `Advice: ${advisory.advice}`);
      return advisory;
    },
  );

  registry.register(
    {
      type: 'ClassifyWeather',
      label: 'Classify Weather',
      description: 'Grades conditions as severe or mild from wind and rain thresholds.',
      category: 'logic',
      traceKind: 'compute',
      tags: ['branching'],
      inputSchema: {
        fields: [
          { name: 'windKmh', type: 'number', required: true },
          { name: 'rainChancePct', type: 'number', required: true },
          // Optional passthrough so fan-out consumers (e.g. a Collect
          // gathering one verdict per city) keep the place name attached.
          { name: 'place', type: 'string' },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'severity', type: 'enum', enumValues: ['severe', 'mild'] },
          { name: 'reason', type: 'string' },
          { name: 'place', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const { severity, reason } = classifyWeather(
        Number(ctx.input.windKmh),
        Number(ctx.input.rainChancePct),
      );
      ctx.log('info', `Severity ${severity}: ${reason}`);
      return {
        severity,
        reason,
        ...(ctx.input.place !== undefined ? { place: ctx.input.place } : {}),
      };
    },
  );

  registry.register(
    {
      type: 'ComposeAlert',
      label: 'Compose Alert',
      description: 'Formats a severe-weather alert line for a place.',
      category: 'logic',
      traceKind: 'compute',
      inputSchema: {
        fields: [
          { name: 'place', type: 'string', required: true },
          { name: 'reason', type: 'string', required: true },
        ],
      },
      outputSchema: {
        fields: [
          { name: 'alert', type: 'string' },
          { name: 'place', type: 'string' },
        ],
      },
    },
    async (ctx) => {
      const place = String(ctx.input.place ?? 'the area');
      const reason = String(ctx.input.reason ?? 'conditions worsening');
      const alert = `⚠ Weather alert for ${place}: ${reason}`;
      ctx.log('info', alert);
      return { alert, place };
    },
  );
}
