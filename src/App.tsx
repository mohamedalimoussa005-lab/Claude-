import { BrowserRouter, Routes, Route } from "react-router-dom";
import { HomePage } from "./pages/Home";
import { ReservationPage } from "./pages/Reservation";
import { AdminPage } from "./pages/Admin";
import { GrainOverlay } from "./components/GrainOverlay/GrainOverlay";

export default function App() {
  return (
    <BrowserRouter>
      <GrainOverlay />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/reservation" element={<ReservationPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </BrowserRouter>
  );
}
