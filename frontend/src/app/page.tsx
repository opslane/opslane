export default function Home() {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-4">Welcome to Opslane</h1>
      <p className="mb-4">Opslane is an AI On-Call Co-Pilot designed to make on-call duties more manageable.</p>
      <p>To get started, visit the <a href="/integrations" className="text-blue-500 hover:underline">Integrations</a> page to set up your Datadog and PagerDuty integrations.</p>
    </div>
  )
}
