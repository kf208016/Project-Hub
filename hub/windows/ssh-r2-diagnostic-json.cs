// Bounded JSON for diagnostic documents. Reject duplicate keys before building objects.
using System;
using System.Text;
using System.Collections.Generic;
using System.Globalization;
using C=HubSshMaintenanceCommon;
public static class HubSshR2DiagnosticJson {
  sealed class Reader {
    readonly string text; int at,nodes;
    public Reader(string value){text=value;}
    void Space(){while(at<text.Length&&(text[at]==' '||text[at]=='\r'||text[at]=='\n'||text[at]=='\t'))at++;}
    void Need(bool value){C.Require(value,"DIAGNOSTIC_JSON_REJECTED");}
    string String(){int start=at;Need(at<text.Length&&text[at++]=='"');bool done=false;while(at<text.Length){char c=text[at++];Need(c>=32);if(c=='"'){done=true;break;}if(c=='\\'){Need(at<text.Length);char e=text[at++];Need("\"\\/bfnrtu".IndexOf(e)>=0);if(e=='u'){for(int i=0;i<4;i++){Need(at<text.Length&&Uri.IsHexDigit(text[at]));at++;}}}}Need(done);string result=C.Json.Deserialize<string>(text.Substring(start,at-start));C.Utf8.GetByteCount(result);return result;}
    object Value(int depth){Space();Need(depth<=24&&++nodes<=16384&&at<text.Length);char c=text[at];if(c=='"')return String();if(c=='{'){at++;var result=new Dictionary<string,object>(StringComparer.Ordinal);Space();if(at<text.Length&&text[at]=='}'){at++;return result;}for(;;){Space();string key=String();Need(!result.ContainsKey(key));Space();Need(at<text.Length&&text[at++]==':');result.Add(key,Value(depth+1));Space();Need(at<text.Length);char next=text[at++];if(next=='}')return result;Need(next==',');}}if(c=='['){at++;var values=new List<object>();Space();if(at<text.Length&&text[at]==']'){at++;return values.ToArray();}for(;;){values.Add(Value(depth+1));Space();Need(at<text.Length);char next=text[at++];if(next==']')return values.ToArray();Need(next==',');}}foreach(string literal in new string[]{"true","false","null"})if(at+literal.Length<=text.Length&&text.Substring(at,literal.Length)==literal){at+=literal.Length;return literal=="null"?null:(object)(literal=="true");}int begin=at;if(c=='-')at++;Need(at<text.Length&&text[at]>='0'&&text[at]<='9');if(text[at]=='0')at++;else while(at<text.Length&&text[at]>='0'&&text[at]<='9')at++;long number;Need(Int64.TryParse(text.Substring(begin,at-begin),NumberStyles.AllowLeadingSign,CultureInfo.InvariantCulture,out number));if(number>=Int32.MinValue&&number<=Int32.MaxValue)return (int)number;return number;}
    public object Read(){object value=Value(0);Space();Need(at==text.Length);return value;}
  }
  public static Dictionary<string,object> Parse(string text,int maximum,bool canonical){C.Require(text!=null&&C.Utf8.GetByteCount(text)<=maximum,"DIAGNOSTIC_JSON_BOUND");var result=new Reader(text).Read() as Dictionary<string,object>;C.Require(result!=null,"DIAGNOSTIC_JSON_OBJECT_REQUIRED");if(canonical)C.Require(Canon(result)==text,"DIAGNOSTIC_NONCANONICAL_JSON");return result;}
  public static string Canon(object value){var d=value as Dictionary<string,object>;if(d!=null){var keys=new List<string>(d.Keys);keys.Sort(StringComparer.Ordinal);var parts=new List<string>();foreach(string k in keys)parts.Add(C.QuoteJson(k)+":"+Canon(d[k]));return "{"+String.Join(",",parts.ToArray())+"}";}var a=value as object[];if(a!=null){var parts=new List<string>();foreach(object v in a)parts.Add(Canon(v));return "["+String.Join(",",parts.ToArray())+"]";}if(value is long)return ((long)value).ToString(CultureInfo.InvariantCulture);return C.Canon(value);}
  public static Dictionary<string,object> Object(Dictionary<string,object> d,string key){object v;C.Require(d!=null&&d.TryGetValue(key,out v)&&v is Dictionary<string,object>,"DIAGNOSTIC_OBJECT_REQUIRED");return (Dictionary<string,object>)d[key];}
  public static object[] Array(Dictionary<string,object> d,string key,int maximum){object v;C.Require(d!=null&&d.TryGetValue(key,out v)&&v is object[],"DIAGNOSTIC_ARRAY_REQUIRED");object[] a=(object[])d[key];C.Require(a.Length<=maximum,"DIAGNOSTIC_ARRAY_BOUND");return a;}
  public static void Bool(Dictionary<string,object> d,string key,bool expected){object v;C.Require(d.TryGetValue(key,out v)&&v is bool&&(bool)v==expected,"DIAGNOSTIC_BOOLEAN_REJECTED");}
}
