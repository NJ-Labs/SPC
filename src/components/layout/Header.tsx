import React from 'react';
import { BarChart3, Info, Languages } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';

const Header: React.FC = () => {
  const { language, setLanguage, t } = useLanguage();

  const toggleLanguage = () => {
    setLanguage(language === 'en' ? 'he' : 'en');
  };

  return (
    <header className="bg-linear-to-r/srgb from-blue-900 to-blue-700 text-white shadow-md">
      <div className="container mx-auto px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <img
              src="/images/logo.png"
              alt="SPC Logo"
              className="h-16 w-auto rounded-xs shadow-xs p-1"
              loading="eager"
              decoding="async"
            />
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                {t('header.title')} <BarChart3 size={26} className="text-teal-300" />
              </h1>
              <p className="text-xs text-blue-200 flex items-center gap-2">
                {t('header.subtitle')}
              </p>
            </div>
          </div>
          
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <img
              src="/images/slogen.png"
              alt="SPC Logo"
              className="h-11 max-w-[12rem] w-auto object-contain rounded-md bg-white/00 shadow-xs p-1"
              loading="eager"
              decoding="async"
            />
            <button 
              className="flex items-center space-x-1 bg-blue-500 hover:bg-blue-600 transition-colors px-3 py-1.5 rounded-md text-sm font-medium no-print"
              onClick={toggleLanguage}
              title={language === 'en' ? 'Switch to Hebrew' : 'עבור לאנגלית'}
            >
              <Languages size={16} />
              <span className="font-semibold">{language === 'en' ? 'עב' : 'EN'}</span>
            </button>
            <button 
              className="flex items-center space-x-1 bg-teal-500 hover:bg-teal-600 transition-colors px-3 py-1.5 rounded-md text-sm font-medium no-print"
              onClick={() => {
                alert(t('header.helpMessage'));
              }}
            >
              <Info size={16} />
              <span>{t('header.help')}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;