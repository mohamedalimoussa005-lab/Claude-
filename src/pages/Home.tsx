import { Nav } from "../components/Nav/Nav";
import { Hero } from "../components/Hero/Hero";
import { Statement } from "../components/Statement/Statement";
import { Craft } from "../components/Craft/Craft";
import { Services } from "../components/Services/Services";
import { Atmosphere } from "../components/Atmosphere/Atmosphere";
import { Salon } from "../components/Salon/Salon";
import { Reputation } from "../components/Reputation/Reputation";
import { Booking } from "../components/Booking/Booking";
import { useLenis } from "../lib/useLenis";

export function HomePage() {
  useLenis();

  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Statement />
        <Craft />
        <Services />
        <Atmosphere />
        <Salon />
        <Reputation />
        <Booking />
      </main>
    </>
  );
}
