import { Link } from 'react-router-dom';

export default function Logo() {
  return (
    <div className="px-6 py-4">
      <Link to="/" className="block hover:opacity-80 transition-opacity">
        <img
          src="/electric-elephant-logo.png"
          alt="Electric Elephant"
          className="h-10 w-auto"
        />
      </Link>
    </div>
  );
}
