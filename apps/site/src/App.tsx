import { Download } from './components/Download';
import { Faq } from './components/Faq';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { HowItWorks } from './components/HowItWorks';
import { Modes } from './components/Modes';
import { Safety } from './components/Safety';
import { Support } from './components/Support';
import { Why } from './components/Why';
import { useScrollReveal } from './lib/motion';

export function App() {
  useScrollReveal();

  return (
    <>
      <Header />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <HowItWorks />
        <Modes />
        <Safety />
        <Why />
        <Download />
        <Faq />
        <Support />
      </main>
      <Footer />
    </>
  );
}
