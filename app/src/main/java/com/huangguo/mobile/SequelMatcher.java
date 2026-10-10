package com.huangguo.mobile;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Conservative title matching creates candidates, never verified season relationships. */
final class SequelMatcher {
    private static final Pattern NUMBERED = Pattern.compile("^(.*?)(?:第)?([0-9一二三四五六七八九十百两]+)(季|部|卷|篇)$");
    private static final Pattern DIGITS = Pattern.compile("^(.*?)([0-9]+)$");
    private static String clean(String title) {
        return title.replaceAll("[\\s\\p{P}\\p{Z}]", "").toLowerCase(java.util.Locale.ROOT);
    }
    static final class Part {
        final String base, kind; final int number;
        Part(String base, String kind, int number) { this.base=base; this.kind=kind; this.number=number; }
    }
    static Part parse(String title) {
        String value=clean(title);
        Matcher m=NUMBERED.matcher(value);
        if(m.matches() && !m.group(1).isEmpty()) return new Part(m.group(1),m.group(3),number(m.group(2)));
        if(value.endsWith("上部") || value.endsWith("下部"))
            return new Part(value.substring(0,value.length()-2),"上下",value.endsWith("上部")?1:2);
        m=DIGITS.matcher(value);
        if(m.matches() && !m.group(1).isEmpty()) return new Part(m.group(1),"数字",number(m.group(2)));
        return new Part(value,"",1);
    }
    private static int number(String value) {
        try { return Integer.parseInt(value); } catch(NumberFormatException ignored) { }
        int result=0, digit=0;
        for(char c:value.toCharArray()) {
            int n="零一二三四五六七八九".indexOf(c);
            if(c=='两') n=2;
            if(n>=0) digit=n;
            else if(c=='十' || c=='百') { result+=(digit==0?1:digit)*(c=='十'?10:100); digit=0; }
            else return -1;
        }
        return result+digit;
    }
    static String query(String title) {
        String base=parse(title).base;
        for(int i=1;i<=title.length();i++) if(clean(title.substring(0,i)).equals(base)) return title.substring(0,i).trim();
        return title.trim();
    }
    static boolean matches(String current, String candidate) {
        Part a=parse(current), b=parse(candidate);
        if(a.base.isEmpty() || !a.base.equals(b.base) || a.number<1 || b.number!=a.number+1) return false;
        if(a.kind.isEmpty()) return b.kind.equals("季") || b.kind.equals("部") || b.kind.equals("数字");
        if(a.kind.equals("数字")) return b.kind.equals("数字") || b.kind.equals("季") || b.kind.equals("部");
        return a.kind.equals(b.kind) || (b.kind.equals("数字") && (a.kind.equals("季") || a.kind.equals("部")));
    }
}
