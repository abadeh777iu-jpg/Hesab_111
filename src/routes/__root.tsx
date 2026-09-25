import { createRootRoute, HeadContent, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <>
      <HeadContent />
      <Outlet />
    </>
  ),
  notFoundComponent: () => (
    <main className="not-found">
      <h1>Nothing to see here. Yet.</h1>
      <p>Let’s get you back to the bigger picture.</p>
      <a className="button" href={import.meta.env.BASE_URL}>
        Back to Scalable
      </a>
    </main>
  ),
});
