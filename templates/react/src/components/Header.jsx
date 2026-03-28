import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="bg-white shadow-sm">
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <a href="/" className="text-xl font-bold text-gray-900">
            Prestige App
          </a>
          <button
            onClick={() => setOpen(!open)}
            className="md:hidden p-2 rounded-md text-gray-600 hover:text-gray-900"
          >
            {open ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="hidden md:flex items-center gap-6">
            <a href="/" className="text-gray-600 hover:text-gray-900">Accueil</a>
            <a href="#" className="text-gray-600 hover:text-gray-900">Services</a>
            <a href="#" className="text-gray-600 hover:text-gray-900">Contact</a>
          </div>
        </div>
        {open && (
          <div className="md:hidden pb-4 space-y-2">
            <a href="/" className="block px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-md">Accueil</a>
            <a href="#" className="block px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-md">Services</a>
            <a href="#" className="block px-3 py-2 text-gray-600 hover:bg-gray-100 rounded-md">Contact</a>
          </div>
        )}
      </nav>
    </header>
  );
}
