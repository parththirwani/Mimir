import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (request.cookies.has("access_token")) {
    return NextResponse.redirect(new URL("/chat", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
