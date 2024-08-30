import React from "react";
import Link from "next/link";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuList,
  NavigationMenuLink,
} from "@/components/ui/navigation-menu";
import { Separator } from "@/components/ui/separator";
import { Zap, Puzzle } from "lucide-react";

export function SideNavbar() {
  return (
    <nav className="w-64 h-screen bg-white border-r border-gray-200">
      <div className="p-4">
        <h1 className="text-2xl font-bold text-black mb-4">Dashboard</h1>
        <NavigationMenu orientation="vertical" className="w-full">
          <NavigationMenuList className="flex flex-col space-y-2">
            <NavigationMenuItem>
              <Link href="/actions" legacyBehavior passHref>
                <NavigationMenuLink className="flex items-center w-full px-3 py-2 text-sm font-medium text-gray-600 rounded-md hover:text-gray-900 hover:bg-gray-50">
                  <Zap className="mr-2 h-4 w-4" />
                  Actions
                </NavigationMenuLink>
              </Link>
            </NavigationMenuItem>
            <Separator className="my-2" />
            <NavigationMenuItem>
              <Link href="/integrations" legacyBehavior passHref>
                <NavigationMenuLink className="flex items-center w-full px-3 py-2 text-sm font-medium text-gray-600 rounded-md hover:text-gray-900 hover:bg-gray-50">
                  <Puzzle className="mr-2 h-4 w-4" />
                  Integrations
                </NavigationMenuLink>
              </Link>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </div>
    </nav>
  );
}