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
      await axios.post(`${API_BASE_URL}/api/v1/integrations/`, {
        name: "Datadog Integration",
        description: "Integration with Datadog for monitoring",
        type: "datadog",
        configuration: {
          api_url: "https://api.datadoghq.com"
        },
        credential_schema: {
          api_key: datadogApiKey,
          app_key: datadogAppKey // Note: Add this to the credential_schema if required
        },
        is_active: true
      });
      alert('Datadog integration successful!');
      setDatadogApiKey('');
      setDatadogAppKey('');
    //   fetchIntegrations(); // Refresh the list of integrations
    } catch (error) {
      alert('Failed to integrate Datadog');
      console.error('Error:', error);
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