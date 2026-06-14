import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

const publicPaths = ["/signin", "/signup", "/api/auth"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));
  if (!req.auth && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    return NextResponse.redirect(url);
  }
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
