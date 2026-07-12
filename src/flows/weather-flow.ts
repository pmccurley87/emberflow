import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../engine';

/**
 * Branching weather advisory:
 *   geocode → forecast → summarize → classify → route(severity?)
 *     ├─ severe → composeAlert → alertResult
 *     └─ mild   → calmResult
 *
 * Two live Open-Meteo HTTP calls feed a summary, then ClassifyWeather grades
 * the conditions and Route sends severe weather down an alert branch while
 * mild weather just surfaces the plain summary.
 */
export function createWeatherFlow(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    {
      id: 'input',
      type: 'Input',
      label: 'Advisory Request',
      position: { x: -180, y: 240 },
      config: {
        fields: [{ name: 'city', type: 'string', required: true }],
        defaults: { city: 'Belfast' },
      },
    },
    {
      id: 'geocode',
      type: 'GeocodeCity',
      label: 'Geocode City',
      position: { x: 60, y: 240 },
      config: { city: 'Belfast' },
      inputMap: {
        city: { sourceNodeId: 'input', sourceField: 'city' },
      },
    },
    {
      id: 'forecast',
      type: 'FetchForecast',
      label: 'Fetch Forecast',
      position: { x: 300, y: 240 },
      config: {},
      inputMap: {
        latitude: { sourceNodeId: 'geocode', sourceField: 'latitude' },
        longitude: { sourceNodeId: 'geocode', sourceField: 'longitude' },
      },
    },
    {
      id: 'summarize',
      type: 'SummarizeConditions',
      label: 'Summarize Conditions',
      position: { x: 540, y: 240 },
      config: {},
      inputMap: {
        place: { sourceNodeId: 'geocode', sourceField: 'place' },
        temperatureC: { sourceNodeId: 'forecast', sourceField: 'temperatureC' },
        windKmh: { sourceNodeId: 'forecast', sourceField: 'windKmh' },
        weatherCode: { sourceNodeId: 'forecast', sourceField: 'weatherCode' },
        maxC: { sourceNodeId: 'forecast', sourceField: 'maxC' },
        minC: { sourceNodeId: 'forecast', sourceField: 'minC' },
        rainChancePct: { sourceNodeId: 'forecast', sourceField: 'rainChancePct' },
      },
    },
    {
      id: 'classify',
      type: 'ClassifyWeather',
      label: 'Classify Weather',
      position: { x: 780, y: 240 },
      config: {},
      inputMap: {
        windKmh: { sourceNodeId: 'forecast', sourceField: 'windKmh' },
        rainChancePct: { sourceNodeId: 'forecast', sourceField: 'rainChancePct' },
      },
    },
    {
      id: 'route',
      type: 'Route',
      label: 'Severity?',
      position: { x: 1020, y: 240 },
      config: { field: 'severity', branches: ['severe'], fallback: 'mild' },
      inputMap: {
        value: { sourceNodeId: 'classify', sourceField: '$' },
      },
    },
    {
      id: 'composeAlert',
      type: 'ComposeAlert',
      label: 'Compose Alert',
      position: { x: 1260, y: 120 },
      config: {},
      inputMap: {
        place: { sourceNodeId: 'geocode', sourceField: 'place' },
        reason: { sourceNodeId: 'classify', sourceField: 'reason' },
      },
    },
    {
      id: 'alertResult',
      type: 'Result',
      label: 'Alert',
      position: { x: 1500, y: 120 },
      config: {},
      inputMap: {
        data: { sourceNodeId: 'composeAlert', sourceField: '$' },
      },
    },
    {
      id: 'calmResult',
      type: 'Result',
      label: 'Advisory',
      position: { x: 1260, y: 360 },
      config: {},
      inputMap: {
        data: { sourceNodeId: 'summarize', sourceField: '$' },
      },
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: 'e0', source: 'input', target: 'geocode', targetHandle: 'city' },
    { id: 'e1', source: 'geocode', target: 'forecast', targetHandle: 'latitude' },
    { id: 'e2', source: 'geocode', target: 'forecast', targetHandle: 'longitude' },
    { id: 'e3', source: 'geocode', target: 'summarize', targetHandle: 'place' },
    { id: 'e4', source: 'forecast', target: 'summarize', targetHandle: 'temperatureC' },
    { id: 'e5', source: 'summarize', target: 'classify' },
    { id: 'e6', source: 'classify', target: 'route', targetHandle: 'value' },
    { id: 'e7', source: 'route', target: 'composeAlert', sourceHandle: 'severe' },
    { id: 'e8', source: 'route', target: 'calmResult', sourceHandle: 'mild' },
    { id: 'e9', source: 'composeAlert', target: 'alertResult', targetHandle: 'data' },
  ];

  return {
    id: 'weather-advisory',
    name: 'Weather Advisory',
    version: 1,
    nodes,
    edges,
    // Live-weather flow: which branch fires depends on real conditions, so the
    // scenarios pick cities that usually sit on opposite sides of the classifier.
    scenarios: [
      {
        id: 'scn-stormy',
        name: 'stormy city',
        description: 'Reykjavik — wind/rain usually trips the severe branch',
        input: { city: 'Reykjavik' },
      },
      {
        id: 'scn-calm',
        name: 'calm city',
        description: 'Valencia — mild branch, plain advisory',
        input: { city: 'Valencia' },
      },
    ],
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
  };
}
