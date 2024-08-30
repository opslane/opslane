'use client';

import { useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '@/config/api';

export default function IntegrationsPage() {
  const [datadogApiKey, setDatadogApiKey] = useState('');
  const [datadogAppKey, setDatadogAppKey] = useState('');
  const [pagerdutyApiKey, setPagerdutyApiKey] = useState('');

  const handleDatadogSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post(`${API_BASE_URL}/api/integrations/datadog`, {
        api_key: datadogApiKey,
        app_key: datadogAppKey,
      });
      alert('Datadog integration successful!');
    } catch (error) {
      alert('Failed to integrate Datadog');
    }
  };

  const handlePagerdutySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await axios.post(`${API_BASE_URL}/api/integrations/pagerduty`, {
        api_key: pagerdutyApiKey,
      });
      alert('PagerDuty integration successful!');
    } catch (error) {
      alert('Failed to integrate PagerDuty');
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-4">Integrations</h1>

      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-2">Datadog</h2>
        <form onSubmit={handleDatadogSubmit} className="space-y-4">
          <div>
            <label htmlFor="datadogApiKey" className="block mb-1">API Key</label>
            <input
              type="text"
              id="datadogApiKey"
              value={datadogApiKey}
              onChange={(e) => setDatadogApiKey(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              required
            />
          </div>
          <div>
            <label htmlFor="datadogAppKey" className="block mb-1">App Key</label>
            <input
              type="text"
              id="datadogAppKey"
              value={datadogAppKey}
              onChange={(e) => setDatadogAppKey(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              required
            />
          </div>
          <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded">
            Integrate Datadog
          </button>
        </form>
      </div>

      <div>
        <h2 className="text-xl font-semibold mb-2">PagerDuty</h2>
        <form onSubmit={handlePagerdutySubmit} className="space-y-4">
          <div>
            <label htmlFor="pagerdutyApiKey" className="block mb-1">API Key</label>
            <input
              type="text"
              id="pagerdutyApiKey"
              value={pagerdutyApiKey}
              onChange={(e) => setPagerdutyApiKey(e.target.value)}
              className="w-full px-3 py-2 border rounded"
              required
            />
          </div>
          <button type="submit" className="bg-green-500 text-white px-4 py-2 rounded">
            Integrate PagerDuty
          </button>
        </form>
      </div>
    </div>
  );
}