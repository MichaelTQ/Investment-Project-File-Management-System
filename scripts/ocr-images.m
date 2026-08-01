#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>

static NSDictionary *RecognizeImage(NSString *path) {
  NSImage *image = [[NSImage alloc] initWithContentsOfFile:path];
  if (image == nil) {
    return @{ @"path": path, @"text": @"", @"lineCount": @0,
              @"error": @"无法读取图片" };
  }

  NSRect rect = NSMakeRect(0, 0, image.size.width, image.size.height);
  CGImageRef cgImage = [image CGImageForProposedRect:&rect context:nil hints:nil];
  if (cgImage == nil) {
    return @{ @"path": path, @"text": @"", @"lineCount": @0,
              @"error": @"无法转换图片" };
  }

  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.recognitionLanguages = @[ @"zh-Hans", @"en-US" ];
  request.usesLanguageCorrection = YES;

  NSError *error = nil;
  VNImageRequestHandler *handler =
      [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];
  BOOL succeeded = [handler performRequests:@[ request ] error:&error];
  if (!succeeded || error != nil) {
    return @{ @"path": path, @"text": @"", @"lineCount": @0,
              @"error": error.localizedDescription ?: @"OCR执行失败" };
  }

  NSMutableArray<NSString *> *lines = [NSMutableArray array];
  for (VNRecognizedTextObservation *observation in request.results) {
    VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
    NSString *line = [candidate.string
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (line.length > 0) {
      [lines addObject:line];
    }
  }

  return @{ @"path": path, @"text": [lines componentsJoinedByString:@"\n"],
            @"lineCount": @(lines.count), @"error": [NSNull null] };
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSMutableArray<NSDictionary *> *results = [NSMutableArray array];
    for (int index = 1; index < argc; index += 1) {
      NSString *path = [NSString stringWithUTF8String:argv[index]];
      [results addObject:RecognizeImage(path)];
    }

    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:results options:0 error:&error];
    if (json == nil || error != nil) {
      fprintf(stderr, "OCR result encoding failed\n");
      return 1;
    }
    fwrite(json.bytes, 1, json.length, stdout);
  }
  return 0;
}
