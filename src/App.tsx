import { AppContextProvider } from './context/AppContext';
import { LanguageProvider } from './context/LanguageContext';
import Header from './components/layout/Header';
import Dashboard from './components/layout/Dashboard';
import Footer from './components/layout/Footer';

function App() {
  return (
    <LanguageProvider>
      <AppContextProvider>
        <div className="flex flex-col min-h-screen bg-gray-50">
          <Header />
          <main className="grow">
            <Dashboard />
          </main>
          <Footer />
        </div>
      </AppContextProvider>
    </LanguageProvider>
  );
}

export default App;