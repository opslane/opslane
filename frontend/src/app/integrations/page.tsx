'use client';

import { useState } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '@/config/api';
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card"

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

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Datadog</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleDatadogSubmit} className="space-y-4">
            <Input
              placeholder="API Key"
              type="text"
              value={datadogApiKey}
              onChange={(e) => setDatadogApiKey(e.target.value)}
              required
            />
            <Input
              placeholder="App Key"
              type="text"
              value={datadogAppKey}
              onChange={(e) => setDatadogAppKey(e.target.value)}
              required
            />
          </form>
        </CardContent>
        <CardFooter>
          <Button onClick={handleDatadogSubmit}>
            Integrate Datadog
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>PagerDuty</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePagerdutySubmit} className="space-y-4">
            <Input
              placeholder="API Key"
              type="text"
              value={pagerdutyApiKey}
              onChange={(e) => setPagerdutyApiKey(e.target.value)}
              required
            />
          </form>
        </CardContent>
        <CardFooter>
          <Button onClick={handlePagerdutySubmit}>
            Integrate PagerDuty
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}