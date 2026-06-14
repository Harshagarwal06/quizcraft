import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import bcrypt from "bcrypt";
import { z } from "zod";

const schema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { name, email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }

  const hashed = await bcrypt.hash(password, 12);
  await prisma.user.create({ data: { name, email, password: hashed } });

  return NextResponse.json({ ok: true }, { status: 201 });
}
