
import { Button } from "@/components/ui/button"
import Link from "next/link"


export default function Home() {

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-4">Welcome to Opslane</h1>
      <p className="mb-4">Opslane is an AI On-Call Co-Pilot designed to make on-call duties more manageable.</p>
      <Button asChild>
        <Link href="/integrations">Get Started with Integrations</Link>
      </Button>
    </div>
  )
}
