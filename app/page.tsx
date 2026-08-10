import Welcome from "./welcome";

/**
 * The landing is the Cortex Welcome experience: hero, principles, how a question gets
 * answered, the two connect paths, the console arrival (a working demo on stand-in
 * notes), and the make-it-yours close. All of it is client-animated, so the page is one
 * client component; the metadata lives in layout.tsx.
 */
export default function Landing() {
  return <Welcome />;
}
