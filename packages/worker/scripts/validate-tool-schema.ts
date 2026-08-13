import Anthropic from '@anthropic-ai/sdk';
import { submitDiagnosisTool } from '../src/diagnose-schema.js';
import { INVESTIGATION_MODEL } from '../src/investigate.js';

const apiKey = process.env['ANTHROPIC_API_KEY'];
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is required to validate the live tool schema');
  process.exitCode = 2;
} else {
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: INVESTIGATION_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Tool-schema validation canary.' }],
      tools: [submitDiagnosisTool()],
    });
    console.log('submit_diagnosis tool schema accepted');
  } catch (error) {
    console.error('submit_diagnosis tool schema rejected', error);
    process.exitCode = 1;
  }
}
