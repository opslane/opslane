'use client';

import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '@/config/api';
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card"

interface IntegrationSchema {
  type: string;
  name: string;
  description: string;
  configuration_schema: Record<string, string>;
  credential_schema: Record<string, string>;
  is_enabled: boolean;
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationSchema[]>([]);
  const [formData, setFormData] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    fetchAvailableIntegrations();
  }, []);

  const fetchAvailableIntegrations = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/v1/integrations/available/`);
      setIntegrations(response.data);
      initializeFormData(response.data);
    } catch (error) {
      console.error('Failed to fetch available integrations:', error);
    }
  };

  const initializeFormData = (integrations: IntegrationSchema[]) => {
    const initialFormData: Record<string, Record<string, string>> = {};
    integrations.forEach(integration => {
      initialFormData[integration.type] = Object.keys(integration.credential_schema).reduce((acc, key) => {
        acc[key] = '';
        return acc;
      }, {} as Record<string, string>);
    });
    setFormData(initialFormData);
  };

  const handleInputChange = (integrationType: string, field: string, value: string) => {
    setFormData(prevData => ({
      ...prevData,
      [integrationType]: {
        ...prevData[integrationType],
        [field]: value
      }
    }));
  };

  const handleSubmit = async (integration: IntegrationSchema) => {
    try {
      await axios.post(`${API_BASE_URL}/api/v1/integrations/`, {
        name: integration.name,
        description: integration.description,
        type: integration.type,
        configuration: integration.configuration_schema,
        credential_schema: formData[integration.type],
        is_active: true
      });
      alert(`${integration.name} integration successful!`);
      fetchAvailableIntegrations();
    } catch (error) {
      alert(`Failed to integrate ${integration.name}`);
      console.error('Error:', error);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-4">Integrations</h1>
      {integrations.map(integration => (
        <Card key={integration.type} className="mb-8">
          <CardHeader>
            <CardTitle>{integration.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{integration.description}</p>
            <form className="space-y-4 mt-4">
              {Object.entries(integration.credential_schema).map(([key, type]) => (
                <Input
                  key={key}
                  placeholder={key}
                  type={type === 'string' ? 'text' : type}
                  value={formData[integration.type]?.[key] || ''}
                  onChange={(e) => handleInputChange(integration.type, key, e.target.value)}
                  required
                />
              ))}
            </form>
          </CardContent>
          <CardFooter>
            <Button onClick={() => handleSubmit(integration)} disabled={integration.is_enabled}>
              {integration.is_enabled ? 'Integrated' : `Integrate ${integration.name}`}
            </Button>
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}