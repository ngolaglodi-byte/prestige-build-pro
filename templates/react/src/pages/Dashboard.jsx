import React from 'react';

export default function Dashboard() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">
        Bienvenue
      </h1>
      <p className="text-lg text-gray-600 mb-12">
        Votre application est en cours de construction. Ce template sera remplace par votre projet.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="w-12 h-12 bg-indigo-100 rounded-lg flex items-center justify-center mb-4">
              <span className="text-indigo-600 font-bold text-lg">{i}</span>
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">Section {i}</h3>
            <p className="text-gray-500 text-sm">
              Contenu de la section qui sera personnalise selon votre projet.
            </p>
          </div>
        ))}
      </div>
    </main>
  );
}
