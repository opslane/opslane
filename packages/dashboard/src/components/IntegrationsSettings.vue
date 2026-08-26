<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  createNotificationDestination,
  deleteNotificationDestination,
  listNotificationDestinations,
  testNotificationDestination,
  updateNotificationDestination,
} from '../api';
import type {
  NotificationDeliveryPolicy,
  NotificationDestination,
  NotificationEventType,
} from '../types/api';
import { formatDate } from '../utils';
import Button from './ui/Button.vue';

const props = defineProps<{ projectId: string }>();

const destinations = ref<NotificationDestination[]>([]);
const canManage = ref(false);
const destinationsProjectId = ref('');
const loading = ref(false);
const loadError = ref('');
const newName = ref('');
const newWebhookURL = ref('');
const newDeliveryPolicy = ref<NotificationDeliveryPolicy>('immediate');
const creating = ref(false);
const mutationPending = ref<Record<string, boolean>>({});
const testResults = ref<Record<string, { ok: boolean; message: string }>>({});
let loadToken = 0;

const notificationEventTypes: ReadonlyArray<{
  value: NotificationEventType;
  label: string;
}> = [
  { value: 'issue.created', label: 'New issue alerts' },
  { value: 'digest.daily', label: 'Daily digest' },
];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function notifyIntegrationsChanged(): void {
	window.dispatchEvent(new Event('opslane-integrations-changed'));
}

async function loadDestinations(projectId: string): Promise<void> {
  const token = ++loadToken;
  destinationsProjectId.value = '';
  loadError.value = '';
  testResults.value = {};

  if (!projectId) {
    destinations.value = [];
    canManage.value = false;
    loading.value = false;
    return;
  }

  loading.value = true;
  try {
    const result = await listNotificationDestinations(projectId);
    if (token !== loadToken) return;
    destinations.value = result.destinations;
    canManage.value = result.can_manage;
    destinationsProjectId.value = projectId;
  } catch (error: unknown) {
    if (token !== loadToken) return;
    destinations.value = [];
    canManage.value = false;
    loadError.value = errorMessage(error, 'Failed to load notification destinations');
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadDestinations(props.projectId);
}

async function createDestination(): Promise<void> {
  const name = newName.value.trim();
  const webhookURL = newWebhookURL.value.trim();
  if (!canManage.value || !props.projectId || !name || !webhookURL) return;

  creating.value = true;
  loadError.value = '';
  try {
		await createNotificationDestination(props.projectId, {
      name,
      webhook_url: webhookURL,
      delivery_policy: newDeliveryPolicy.value,
		});
		notifyIntegrationsChanged();
    newName.value = '';
    newWebhookURL.value = '';
    newDeliveryPolicy.value = 'immediate';
    await refresh();
  } catch (error: unknown) {
    loadError.value = errorMessage(error, 'Failed to add Slack notification');
  } finally {
    creating.value = false;
  }
}

function setMutationPending(destinationId: string, pending: boolean): void {
  mutationPending.value = { ...mutationPending.value, [destinationId]: pending };
}

async function setEnabled(destination: NotificationDestination, enabled: boolean): Promise<void> {
  if (!canManage.value || mutationPending.value[destination.id]) return;

  setMutationPending(destination.id, true);
  loadError.value = '';
  try {
		await updateNotificationDestination(props.projectId, destination.id, { enabled });
		notifyIntegrationsChanged();
    await refresh();
  } catch (error: unknown) {
    loadError.value = errorMessage(error, 'Failed to update notification destination');
  } finally {
    setMutationPending(destination.id, false);
  }
}

function onEnabledChange(destination: NotificationDestination, event: Event): void {
  const enabled = event.target instanceof HTMLInputElement && event.target.checked;
  void setEnabled(destination, enabled);
}

async function setEventType(
  destination: NotificationDestination,
  eventType: NotificationEventType,
  checked: boolean,
): Promise<void> {
  if (!canManage.value || mutationPending.value[destination.id]) return;

  const eventTypes = checked
    ? [...destination.event_types, eventType]
    : destination.event_types.filter((candidate) => candidate !== eventType);
  if (eventTypes.length === 0) return;

  setMutationPending(destination.id, true);
  loadError.value = '';
  try {
		await updateNotificationDestination(props.projectId, destination.id, {
			event_types: eventTypes,
		});
		notifyIntegrationsChanged();
    await refresh();
  } catch (error: unknown) {
    loadError.value = errorMessage(error, 'Failed to update notification subscriptions');
  } finally {
    setMutationPending(destination.id, false);
  }
}

function onEventTypeChange(
  destination: NotificationDestination,
  eventType: NotificationEventType,
  event: Event,
): void {
  const checked = event.target instanceof HTMLInputElement && event.target.checked;
  void setEventType(destination, eventType, checked);
}

async function setDeliveryPolicy(
  destination: NotificationDestination,
  deliveryPolicy: NotificationDeliveryPolicy,
): Promise<void> {
  if (!canManage.value || mutationPending.value[destination.id]) return;

  setMutationPending(destination.id, true);
  loadError.value = '';
  try {
		await updateNotificationDestination(props.projectId, destination.id, {
			delivery_policy: deliveryPolicy,
		});
		notifyIntegrationsChanged();
    await refresh();
  } catch (error: unknown) {
    loadError.value = errorMessage(error, 'Failed to update alert timing');
  } finally {
    setMutationPending(destination.id, false);
  }
}

function onDeliveryPolicyChange(destination: NotificationDestination, event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  void setDeliveryPolicy(destination, event.target.value as NotificationDeliveryPolicy);
}

async function removeDestination(destination: NotificationDestination): Promise<void> {
  if (!canManage.value || mutationPending.value[destination.id]) return;
  if (!window.confirm(`Delete notification destination "${destination.name}"?`)) return;

  setMutationPending(destination.id, true);
  loadError.value = '';
  try {
		await deleteNotificationDestination(props.projectId, destination.id);
		notifyIntegrationsChanged();
    await refresh();
  } catch (error: unknown) {
    loadError.value = errorMessage(error, 'Failed to delete notification destination');
  } finally {
    setMutationPending(destination.id, false);
  }
}

async function sendTest(
  destination: NotificationDestination,
  eventType?: NotificationEventType,
): Promise<void> {
  if (!canManage.value || mutationPending.value[destination.id]) return;

  setMutationPending(destination.id, true);
  const previousResults = { ...testResults.value };
  delete previousResults[destination.id];
  testResults.value = previousResults;
  try {
		const result = await testNotificationDestination(
      props.projectId,
      destination.id,
      eventType ? { eventType } : undefined,
		);
		notifyIntegrationsChanged();
    const status = result.status_code ? ` (HTTP ${result.status_code})` : '';
    testResults.value = {
      ...testResults.value,
      [destination.id]: {
        ok: result.ok,
        message: result.ok
          ? `Test delivered${status}.`
          : `Test failed: ${result.classification}${status}.`,
      },
    };
  } catch (error: unknown) {
    testResults.value = {
      ...testResults.value,
      [destination.id]: {
        ok: false,
        message: errorMessage(error, 'Failed to test notification destination'),
      },
    };
  } finally {
    setMutationPending(destination.id, false);
  }
}

function deliveryClass(status: string): string {
  if (status === 'delivered') return 'bg-success/10 text-success';
  if (status === 'failed') return 'bg-danger/10 text-danger';
  return 'bg-surface-subtle text-muted';
}

watch(
  () => props.projectId,
  (projectId) => { void loadDestinations(projectId); },
  { immediate: true },
);
</script>

<template>
  <section class="space-y-6">
    <div>
      <h3 class="text-sm font-medium text-text">Notification integrations</h3>
      <p class="mt-1 text-sm text-muted">
        Send new issue alerts and daily project digests to Slack.
      </p>
    </div>

    <p v-if="!projectId" class="text-sm text-muted">
      Select a project to configure notification integrations.
    </p>
    <p v-else-if="loading" class="text-sm text-muted">Loading integrations...</p>
    <p v-if="loadError" class="text-sm text-danger" role="alert" v-text="loadError"></p>

    <template v-if="projectId && !loading && destinationsProjectId === projectId">
      <ul v-if="destinations.length > 0" class="space-y-3">
        <li
          v-for="destination in destinations"
          :key="destination.id"
          class="rounded-lg border border-border bg-surface p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium text-text" v-text="destination.name"></span>
                <span class="inline-flex rounded-full bg-progress/10 px-2 py-0.5 text-xs font-medium text-progress">
                  Slack
                </span>
                <span
                  v-if="!canManage"
                  class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="destination.enabled ? 'bg-success/10 text-success' : 'bg-surface-subtle text-muted'"
                >
                  {{ destination.enabled ? 'Enabled' : 'Disabled' }}
                </span>
              </div>
              <p class="break-all font-mono text-xs text-muted" v-text="destination.config_fingerprint"></p>
            </div>

            <label v-if="canManage" class="relative inline-flex shrink-0 cursor-pointer items-center">
              <span class="sr-only">Enable {{ destination.name }}</span>
              <input
                type="checkbox"
                role="switch"
                class="peer sr-only"
                :aria-label="`Enable ${destination.name}`"
                :checked="destination.enabled"
                :disabled="mutationPending[destination.id]"
                @change="onEnabledChange(destination, $event)"
              />
              <span class="h-6 w-11 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5"></span>
            </label>
          </div>

          <fieldset v-if="canManage" class="mt-4">
            <legend class="text-xs font-medium text-muted">Messages to send</legend>
            <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              <label
                v-for="eventType in notificationEventTypes"
                :key="eventType.value"
                class="inline-flex items-center gap-2 text-sm text-text"
              >
                <input
                  type="checkbox"
                  :aria-label="`${eventType.label} for ${destination.name}`"
                  :checked="destination.event_types.includes(eventType.value)"
                  :disabled="mutationPending[destination.id]
                    || (destination.event_types.length === 1
                      && destination.event_types.includes(eventType.value))"
                  @change="onEventTypeChange(destination, eventType.value, $event)"
                />
                <span v-text="eventType.label"></span>
              </label>
            </div>
          </fieldset>

          <fieldset v-if="canManage && destination.event_types.includes('issue.created')" class="mt-4">
            <legend class="text-xs font-medium text-muted">New issue alert timing</legend>
            <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              <label class="inline-flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  :name="`delivery-policy-${destination.id}`"
                  :aria-label="`Alert immediately for ${destination.name}`"
                  value="immediate"
                  :checked="destination.delivery_policy === 'immediate'"
                  :disabled="mutationPending[destination.id]"
                  @change="onDeliveryPolicyChange(destination, $event)"
                />
                <span>Alert immediately</span>
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-text">
                <input
                  type="radio"
                  :name="`delivery-policy-${destination.id}`"
                  :aria-label="`Alert after triage for ${destination.name}`"
                  value="post_triage"
                  :checked="destination.delivery_policy === 'post_triage'"
                  :disabled="mutationPending[destination.id]"
                  @change="onDeliveryPolicyChange(destination, $event)"
                />
                <span>Alert after triage</span>
              </label>
            </div>
          </fieldset>

          <div class="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <template v-if="destination.last_delivery">
              <span
                class="inline-flex rounded-full px-2 py-0.5 font-medium"
                :class="deliveryClass(destination.last_delivery.status)"
                :title="destination.last_delivery.error ?? undefined"
              >
                {{ destination.last_delivery.status }}
              </span>
              <span class="text-muted">
                {{ formatDate(destination.last_delivery.at) }}
              </span>
              <span
                v-if="destination.last_delivery.error"
                class="max-w-full truncate text-danger"
                :title="destination.last_delivery.error"
                v-text="destination.last_delivery.error"
              ></span>
            </template>
            <span v-else class="text-muted">No deliveries yet</span>
            <span v-if="destination.recent_failures > 0" class="text-danger">
              {{ destination.recent_failures }} failed in the last 7 days
            </span>
          </div>

          <div v-if="canManage" class="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="secondary" :disabled="mutationPending[destination.id]" @click="sendTest(destination)">
              {{ mutationPending[destination.id] ? 'Working...' : 'Test' }}
            </Button>
            <Button variant="secondary" :disabled="mutationPending[destination.id]" @click="sendTest(destination, 'digest.daily')">
              Send digest preview
            </Button>
            <Button variant="danger" class="rounded-lg text-danger hover:bg-danger/10" :disabled="mutationPending[destination.id]" @click="removeDestination(destination)">
              Delete
            </Button>
            <span
              v-if="testResults[destination.id]"
              class="text-sm"
              :class="testResults[destination.id].ok ? 'text-success' : 'text-danger'"
              role="status"
              v-text="testResults[destination.id].message"
            ></span>
          </div>
        </li>
      </ul>
      <p v-else class="text-sm text-muted">No notification integrations yet.</p>

      <form
        v-if="canManage"
        class="space-y-4 border-t border-border pt-6"
        data-testid="add-slack-form"
        @submit.prevent="createDestination"
      >
        <div>
          <h4 class="text-sm font-medium text-text">Add Slack notification</h4>
          <p class="mt-1 text-xs text-muted">
            Create an incoming webhook in Slack, then paste its URL below.
            <a
              href="https://api.slack.com/messaging/webhooks"
              target="_blank"
              rel="noopener noreferrer"
              class="text-accent hover:underline"
            >Slack webhook guide</a>
          </p>
        </div>
        <fieldset>
          <legend class="block text-sm font-medium text-muted">New issue alert timing</legend>
          <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            <label class="inline-flex items-center gap-2 text-sm text-text">
              <input v-model="newDeliveryPolicy" type="radio" name="delivery-policy-new" value="immediate" :disabled="creating" />
              <span>Alert immediately</span>
            </label>
            <label class="inline-flex items-center gap-2 text-sm text-text">
              <input v-model="newDeliveryPolicy" type="radio" name="delivery-policy-new" value="post_triage" :disabled="creating" />
              <span>Alert after triage</span>
            </label>
          </div>
        </fieldset>
        <div>
          <label for="notification-name" class="block text-sm font-medium text-muted">Name</label>
          <input
            id="notification-name"
            v-model="newName"
            type="text"
            maxlength="200"
            required
            placeholder="Production alerts"
            :disabled="creating"
            class="mt-1 block w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
        </div>
        <div>
          <label for="notification-webhook-url" class="block text-sm font-medium text-muted">
            Webhook URL
          </label>
          <input
            id="notification-webhook-url"
            v-model="newWebhookURL"
            type="url"
            required
            autocomplete="off"
            placeholder="https://hooks.slack.com/services/..."
            :disabled="creating"
            class="mt-1 block w-full rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
        </div>
        <Button variant="primary" type="submit" :disabled="creating || !newName.trim() || !newWebhookURL.trim()">
          {{ creating ? 'Adding...' : 'Add Slack notification' }}
        </Button>
      </form>

      <p v-else class="text-sm text-muted">
        You can view integrations for this project, but only an organization admin can change them.
      </p>
    </template>
  </section>
</template>
